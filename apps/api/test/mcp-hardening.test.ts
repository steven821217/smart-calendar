import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import type { AuthContext } from "../src/auth/jwt.js";
import { toolBookResource, toolCreateSmartEvent, toolFindAvailability } from "../src/mcp/tools.js";
import { revokeAgent, unrevokeAgent } from "../src/agents/service.js";
import { listAudit } from "../src/audit/service.js";

async function ctx() {
  const admin = new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  await admin.connect();
  const ws = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  const cal = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 LIMIT 1`, [ws])).rows[0].id;
  const mem = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [ws])).rows[0].id;
  const res = (await admin.query(`SELECT id FROM resources WHERE workspace_id=$1 LIMIT 1`, [ws])).rows[0]?.id ?? null;
  await admin.end();
  return { ws, cal, mem, res };
}

let WS: string, CAL: string, MEM: string, RES: string | null;
beforeAll(async () => { const c = await ctx(); WS = c.ws; CAL = c.cal; MEM = c.mem; RES = c.res; });

const agentAuth = (sub: string, over: Partial<AuthContext> = {}): AuthContext => ({
  sub, workspace: WS, roles: ["scheduler"],
  scope: ["availability.read", "event.write", "resource.book"], ...over,
});

describe("MCP require_confirmation (MCP-12, 8.5)", () => {
  it("book_resource 無 confirm → confirmation_required，不落實", async () => {
    const r = await toolBookResource(agentAuth("agent-confirm"), {
      resource_id: RES ?? "00000000-0000-0000-0000-000000000000",
      event_id: "00000000-0000-0000-0000-000000000000",
      start_utc: "2027-06-01T02:00:00Z", end_utc: "2027-06-01T03:00:00Z",
    });
    expect(r.status).toBe("confirmation_required");
    expect(r.require_confirmation).toBe(true);
  });
});

describe("find_availability 僅 free/busy (MCP-11)", () => {
  it("回傳只含 slots，不洩漏事件內容", async () => {
    const r = await toolFindAvailability(agentAuth("agent-fb"), {
      from_utc: "2027-06-02T00:00:00Z", to_utc: "2027-06-02T09:00:00Z", duration_minutes: 30,
      busy: [{ start: Date.parse("2027-06-02T02:00:00Z"), end: Date.parse("2027-06-02T03:00:00Z") }],
    });
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) {
      expect(Object.keys(s).sort()).toEqual(["end_utc", "score", "start_utc"]);
    }
  });
});

describe("agent 稽核 (MCP-13, 8.6)", () => {
  it("每次 tool 呼叫寫 audit(actor_type=agent, agent_id, source)", async () => {
    // agent 的身分 = token.sub，須為有效 membership UUID（created_by FK）
    await toolCreateSmartEvent(agentAuth(MEM), {
      calendar_id: CAL, title: "AuditedAgentEvt",
      start_utc: "2027-06-03T06:00:00Z", end_utc: "2027-06-03T07:00:00Z", timezone: "UTC",
    });
    const { entries } = await listAudit(WS, { actor_type: "agent", agent_id: MEM });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].agent_id).toBe(MEM);
    expect(entries[0].decision).toBe("allow");
  });
});

describe("ZT-7 撤銷後即時 fail-closed (MCP-8, 8.7)", () => {
  it("原本可呼叫的 agent，撤銷後 → forbidden，且 DB 不新增", async () => {
    const admin = new pg.Client({
      connectionString:
        process.env.ADMIN_DATABASE_URL ??
        `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
    });
    await admin.connect();
    const sub = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
    await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND title IN ('BeforeRevoke','AfterRevoke')`, [WS]);

    // 這個 sub 與其他測試共用（同一個 workspace 的第一個 membership）。撤銷是全域
    // Redis 副作用，因此本測試「借用即歸還」：驗證完立刻 unrevoke，避免污染
    // fileParallelism=false 下後續執行的測試（如 mcp-zerotrust）。
    try {
      // 撤銷前可成功建立
      const ok = await toolCreateSmartEvent(agentAuth(sub), {
        calendar_id: CAL, title: "BeforeRevoke",
        start_utc: "2027-07-01T06:00:00Z", end_utc: "2027-07-01T07:00:00Z", timezone: "UTC",
      });
      expect(ok.status).toBe("created");

      // 撤銷 → 下次呼叫立即拒絕
      await revokeAgent(WS, sub);
      await expect(
        toolCreateSmartEvent(agentAuth(sub), {
          calendar_id: CAL, title: "AfterRevoke",
          start_utc: "2027-07-01T08:00:00Z", end_utc: "2027-07-01T09:00:00Z", timezone: "UTC",
        }),
      ).rejects.toMatchObject({ kind: "forbidden" });

      // DB 未新增 AfterRevoke（撤銷確實阻斷寫入）
      const n = (await admin.query(
        `SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND title='AfterRevoke'`, [WS],
      )).rows[0].n;
      expect(n).toBe(0);
    } finally {
      // 歸還：解除撤銷 + 關閉連線，無論斷言成敗都執行
      await unrevokeAgent(WS, sub);
      await admin.end();
    }
  });
});
