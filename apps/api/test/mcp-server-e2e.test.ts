import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * MCP server 端到端（stdio）：以程式化 MCP client spawn 真的 server 進程，
 * 驗證「MCP 通了」= tools 列得到、授權鏈生效、delegate 端到端跑得動。
 * 不依賴外部 GUI；CI 無 OPENAI_API_KEY 時以 MCP_STUB_MODEL=1 走 stub。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS: string, CAL: string, MEM: string, MEM2: string, VEHICLE: string;
const BOB_NAME = "Bob Mcp";
const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/mcp/server.ts",
);

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  CAL = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS])).rows[0].id;
  MEM = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  const bobUser = (
    await admin.query(
      `INSERT INTO users(email,display_name) VALUES('bob-mcp@example.com',$1)
       ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
      [BOB_NAME],
    )
  ).rows[0].id;
  MEM2 = (
    await admin.query(
      `INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member')
       ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='member' RETURNING id`,
      [WS, bobUser],
    )
  ).rows[0].id;
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE 'McpVehicle%'`, [WS]);
  VEHICLE = (
    await admin.query(
      `INSERT INTO resources(workspace_id,name,type) VALUES($1,'McpVehicle-公務車','equipment') RETURNING id`,
      [WS],
    )
  ).rows[0].id;
  await admin.end();
});

afterAll(async () => {
  // 清掉本測試建的公務車與其 booking，避免改變 ws-a「第一台需交接資源」而污染 committee 測試。
  const admin = adminClient();
  await admin.connect();
  await admin.query(
    `DELETE FROM resource_bookings WHERE resource_id IN
       (SELECT id FROM resources WHERE workspace_id=$1 AND name LIKE 'McpVehicle%')`,
    [WS],
  );
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE 'McpVehicle%'`, [WS]);
  await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND start_utc >= '2027-01-01'`, [WS]);
  await admin.end();
});
async function connectClient(scope = "availability.read,event.write,resource.book") {
  const transport = new StdioClientTransport({
    command: "pnpm",
    args: ["exec", "tsx", serverEntry],
    env: {
      ...process.env,
      MCP_DEV_WORKSPACE: WS,
      MCP_DEV_SUB: MEM,
      MCP_DEV_SCOPE: scope,
      MCP_STUB_MODEL: "1",
      MCP_STUB_MEMBER_ID: MEM2,
    } as Record<string, string>,
  });
  const client = new Client({ name: "e2e-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function parse(res: unknown): { isError?: boolean; payload: Record<string, unknown> } {
  const r = res as { isError?: boolean; content: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text ?? "{}";
  return { isError: r.isError, payload: JSON.parse(text) };
}

describe("MCP server E2E (stdio)", () => {
  it("列出全部 tools（7 個）", async () => {
    const { client, transport } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "book_resource",
          "create_smart_event",
          "delegate_complex_scheduling",
          "find_available_time_slots",
          "list_event_occurrences",
          "parse_event_from_text",
          "query_calendar",
        ].sort(),
      );
    } finally {
      await transport.close();
    }
  });

  it("find_available_time_slots：唯讀，授權鏈通過，回 slots", async () => {
    const { client, transport } = await connectClient();
    try {
      const res = await client.callTool({
        name: "find_available_time_slots",
        arguments: {
          from_utc: "2027-10-01T00:00:00Z",
          to_utc: "2027-10-01T08:00:00Z",
          duration_minutes: 60,
          busy: [],
        },
      });
      const { isError, payload } = parse(res);
      expect(isError).toBeFalsy();
      expect(Array.isArray(payload.slots)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("book_resource 無 confirm → confirmation_required（MCP-12）", async () => {
    const { client, transport } = await connectClient();
    try {
      const res = await client.callTool({
        name: "book_resource",
        arguments: {
          resource_id: VEHICLE,
          event_id: "00000000-0000-0000-0000-000000000000",
          start_utc: "2027-10-02T02:00:00Z",
          end_utc: "2027-10-02T03:00:00Z",
        },
      });
      const { payload } = parse(res);
      expect(payload.status).toBe("confirmation_required");
    } finally {
      await transport.close();
    }
  });

  it("零信任：缺 resource.book scope → delegate 回 insufficient_scope", async () => {
    const { client, transport } = await connectClient("availability.read,event.write");
    try {
      const res = await client.callTool({
        name: "delegate_complex_scheduling",
        arguments: { task_description: "x", confirm: true },
      });
      const { isError, payload } = parse(res);
      expect(isError).toBe(true);
      expect(payload.error).toBe("insufficient_scope");
    } finally {
      await transport.close();
    }
  });

  it("delegate_complex_scheduling confirm=true（stub model）→ booked，含 buffer/提醒", async () => {
    const { client, transport } = await connectClient();
    try {
      const res = await client.callTool({
        name: "delegate_complex_scheduling",
        arguments: {
          task_description: `幫我跟 ${BOB_NAME} 借一輛公務車，2027-10-03 下午 2 點，1 小時`,
          reference_now_utc: "2026-09-15T00:00:00Z",
          default_timezone: "UTC",
          confirm: true,
          calendar_id: CAL,
          title: "MCP E2E 拜訪",
        },
      });
      const { isError, payload } = parse(res);
      expect(isError).toBeFalsy();
      expect(payload.status).toBe("booked");
      const result = payload.result as {
        event: { source: string };
        booking: { resource_id: string; start_utc: string; end_utc: string };
        actual_usage: { start_utc: string; end_utc: string };
        reminders: Array<{ lead_minutes: number; channel: string }>;
      };
      expect(result.event.source).toBe("agent");
      // resourceManager 挑 workspace 內第一台「需交接資源」（equipment + 名稱含公務車），
      // 未必等於本測試 seed 的那台，故驗證「是一台公務車」而非特定 id。
      expect(await isVehicleResource(result.booking.resource_id)).toBe(true);
      const bufMs = 15 * 60_000;
      expect(Date.parse(result.actual_usage.start_utc) - Date.parse(result.booking.start_utc)).toBe(bufMs);
      expect(result.reminders[0].lead_minutes).toBe(30);
    } finally {
      await transport.close();
    }
  });

  it("delegate explain=true → 回 trace，DB 無寫入", async () => {
    const before = await eventCount();
    const { client, transport } = await connectClient();
    try {
      const res = await client.callTool({
        name: "delegate_complex_scheduling",
        arguments: {
          task_description: `跟 ${BOB_NAME} 借公務車 2027-10-04 下午 1 點`,
          reference_now_utc: "2026-09-15T00:00:00Z",
          default_timezone: "UTC",
          explain: true,
          confirm: true,
          calendar_id: CAL,
        },
      });
      const { payload } = parse(res);
      expect(payload.explain).toBe(true);
      expect(Array.isArray(payload.trace)).toBe(true);
      expect(await eventCount()).toBe(before);
    } finally {
      await transport.close();
    }
  });
});

async function eventCount() {
  const admin = adminClient();
  await admin.connect();
  const r = await admin.query(`SELECT count(*)::int AS n FROM events WHERE workspace_id=$1`, [WS]);
  await admin.end();
  return r.rows[0].n as number;
}

async function isVehicleResource(resourceId: string): Promise<boolean> {
  const admin = adminClient();
  await admin.connect();
  const r = await admin.query(
    `SELECT 1 FROM resources WHERE workspace_id=$1 AND id=$2 AND type='equipment' AND name LIKE '%公務車%'`,
    [WS, resourceId],
  );
  await admin.end();
  return r.rows.length > 0;
}
