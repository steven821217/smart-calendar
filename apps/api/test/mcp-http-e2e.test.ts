import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildHttpServer } from "../src/mcp/http.js";
import { signJwt } from "../src/auth/jwt.js";

/**
 * MCP Streamable HTTP 端到端（對外傳輸，mcp.md §6/§7）：
 * 起一個 loopback HTTP server（MCP_STUB_MODEL=1 讓委員會走 stub），
 * 用 StreamableHTTPClientTransport 帶 Bearer token 連，驗證：
 *  - 帶有效 token → 列 tools / 呼叫成功
 *  - 無 token → 協定層 401（session 開不起來）
 *  - workspace/scope 來自 token（per-request 授權，ZT-5）
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS: string, CAL: string, MEM: string, MEM2: string;
let server: Server;
let baseUrl: string;
const BOB_NAME = "Bob Http";

beforeAll(async () => {
  process.env.MCP_STUB_MODEL = "1";

  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  CAL = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS])).rows[0].id;
  MEM = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  const bobUser = (
    await admin.query(
      `INSERT INTO users(email,display_name) VALUES('bob-http@example.com',$1)
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
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE 'HttpVehicle%'`, [WS]);
  await admin.query(
    `INSERT INTO resources(workspace_id,name,type) VALUES($1,'HttpVehicle-公務車','equipment')`,
    [WS],
  );
  await admin.end();

  // stub member id 供委員會解析
  process.env.MCP_STUB_MEMBER_ID = MEM2;

  server = buildHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  const admin = adminClient();
  await admin.connect();
  await admin.query(
    `DELETE FROM resource_bookings WHERE resource_id IN
       (SELECT id FROM resources WHERE workspace_id=$1 AND name LIKE 'HttpVehicle%')`,
    [WS],
  );
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE 'HttpVehicle%'`, [WS]);
  await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND start_utc >= '2027-01-01'`, [WS]);
  await admin.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function agentToken(scope = "availability.read,event.write,resource.book"): string {
  return signJwt(
    { sub: MEM, workspace: WS, roles: ["scheduler"], scope: scope.split(",").map((s) => s.trim()) },
    3600,
  );
}

async function connect(token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "http-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function parse(res: unknown): { isError?: boolean; payload: Record<string, unknown> } {
  const r = res as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: r.isError, payload: JSON.parse(r.content?.[0]?.text ?? "{}") };
}

describe("MCP Streamable HTTP E2E", () => {
  it("帶有效 Bearer → 列 tools", async () => {
    const { client, transport } = await connect(agentToken());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("delegate_complex_scheduling");
      expect(tools.map((t) => t.name)).toContain("query_calendar");
      expect(tools.map((t) => t.name)).toContain("whoami");
      expect(tools.length).toBe(10);
    } finally {
      await transport.close();
    }
  });

  it("無 Bearer token → 連線被拒（401，session 開不起來）", async () => {
    await expect(connect(undefined)).rejects.toBeTruthy();
  });

  it("find_available_time_slots：授權鏈通過", async () => {
    const { client, transport } = await connect(agentToken());
    try {
      const res = await client.callTool({
        name: "find_available_time_slots",
        arguments: { from_utc: "2027-11-01T00:00:00Z", to_utc: "2027-11-01T08:00:00Z", duration_minutes: 60, busy: [] },
      });
      const { isError, payload } = parse(res);
      expect(isError).toBeFalsy();
      expect(Array.isArray(payload.slots)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("零信任：token 缺 resource.book → delegate insufficient_scope", async () => {
    const { client, transport } = await connect(agentToken("availability.read,event.write"));
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

  it("delegate confirm=true（stub）→ booked，來自 token 的 workspace", async () => {
    const { client, transport } = await connect(agentToken());
    try {
      const res = await client.callTool({
        name: "delegate_complex_scheduling",
        arguments: {
          task_description: `幫我跟 ${BOB_NAME} 借公務車 2027-11-03 下午 2 點，1 小時`,
          reference_now_utc: "2026-09-15T00:00:00Z",
          default_timezone: "UTC",
          confirm: true,
          calendar_id: CAL,
          title: "HTTP E2E",
        },
      });
      const { isError, payload } = parse(res);
      expect(isError).toBeFalsy();
      expect(payload.status).toBe("booked");
      const result = payload.result as { event: { source: string }; reminders: Array<{ lead_minutes: number }> };
      expect(result.event.source).toBe("agent");
      expect(result.reminders[0].lead_minutes).toBe(30);
    } finally {
      await transport.close();
    }
  });
});
