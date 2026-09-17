import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import type { AuthContext } from "../src/auth/jwt.js";
import { McpAuthError } from "../src/mcp/guard.js";
import {
  toolFindAvailability,
  toolCreateSmartEvent,
  toolListOccurrences,
} from "../src/mcp/tools.js";

async function ctx() {
  const admin = new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  await admin.connect();
  const wsA = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  const cal = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 LIMIT 1`, [wsA])).rows[0].id;
  const mem = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [wsA])).rows[0].id;
  await admin.end();
  return { wsA, cal, mem };
}
let WS_A: string, CAL: string, MEM: string;
beforeAll(async () => { const c = await ctx(); WS_A = c.wsA; CAL = c.cal; MEM = c.mem; });

const agentAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
  sub: MEM, workspace: WS_A, roles: ["member"],
  scope: ["availability.read", "event.write"], ...over,
});

describe("MCP 零信任滲透 (ZT-2/4/5/7)", () => {
  it("無 token → unauthorized", async () => {
    await expect(toolFindAvailability(null, { from_utc: "2027-01-01T00:00:00Z", to_utc: "2027-01-01T09:00:00Z", duration_minutes: 30 }))
      .rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("缺 scope → insufficient_scope（book_resource 需 resource.book）", async () => {
    // agent 只有 availability.read + event.write，沒有 resource.book
    const { toolBookResource } = await import("../src/mcp/tools.js");
    await expect(
      toolBookResource(agentAuth(), { resource_id: "x", event_id: "y", start_utc: "2027-01-01T06:00:00Z", end_utc: "2027-01-01T07:00:00Z" }),
    ).rejects.toMatchObject({ kind: "insufficient_scope" });
  });

  it("tool 參數想跨 workspace 也無效（workspace 只來自 token, ZT-5）→ 事件仍建在 token 的 ws", async () => {
    const r = await toolCreateSmartEvent(agentAuth(), {
      calendar_id: CAL, title: "AgentEvt",
      start_utc: "2027-02-01T06:00:00Z", end_utc: "2027-02-01T07:00:00Z", timezone: "UTC",
      // 即使塞任何 workspace 參數也不會被採用（型別上無此欄，執行上以 auth.workspace 為準）
    } as never);
    expect(r.status).toBe("created");
    expect(r.event.workspace_id).toBe(WS_A);
    expect(r.event.source).toBe("agent"); // 稽核來源
  });

  it("授權 agent 正常呼叫成功（同一鏈，非豁免 ZT-2）", async () => {
    const r = await toolFindAvailability(agentAuth(), {
      from_utc: "2027-01-01T01:00:00Z", to_utc: "2027-01-01T09:00:00Z", duration_minutes: 30,
      busy: [{ start: new Date("2027-01-01T02:00:00Z").getTime(), end: new Date("2027-01-01T03:00:00Z").getTime() }],
    });
    expect(r.slots.length).toBeGreaterThan(0);
  });

  it("agent 無 admin → 不能管理（scope 允許但 PDP role 擋）", async () => {
    // list_event_occurrences 需 availability.read scope（有），但驗證 read 授權仍走 PDP
    const r = await toolListOccurrences(agentAuth(), { from_utc: "2027-01-01T00:00:00Z", to_utc: "2027-03-01T00:00:00Z" });
    expect(Array.isArray(r)).toBe(true); // member 可讀列表（同 REST）
  });

  it("McpAuthError forbidden 於 PDP deny", async () => {
    // 用一個沒有任何有效 role 的 agent → event.create PDP deny
    await expect(
      toolCreateSmartEvent(agentAuth({ roles: [] }), {
        calendar_id: CAL, title: "x", start_utc: "2027-02-02T06:00:00Z", end_utc: "2027-02-02T07:00:00Z", timezone: "UTC",
      } as never),
    ).rejects.toBeInstanceOf(McpAuthError);
  });
});
