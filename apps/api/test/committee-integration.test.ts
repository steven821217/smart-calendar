import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import type { z } from "zod";
import type { AuthContext } from "../src/auth/jwt.js";
import type { ChatModel, ChatMessage } from "../src/agents/llm.js";
import { toolDelegateComplexScheduling } from "../src/mcp/tools.js";
import { revokeAgent, unrevokeAgent } from "../src/agents/service.js";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS: string, WS_B: string, CAL: string, MEM: string, MEM2: string, VEHICLE: string;
const BOB_NAME = "Bob Committee";

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  WS_B = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-b'`)).rows[0].id;
  CAL = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS])).rows[0].id;
  MEM = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;

  // 加一位名為 Bob Committee 的成員供名字比對
  const bobUser = (
    await admin.query(
      `INSERT INTO users(email,display_name) VALUES('bob-committee@example.com',$1)
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

  // 乾淨起點：清掉 ws-a 內所有測試公務車與其 booking，確保 resourceManager 挑到的
  // 「第一台需交接資源」是本檔建的那台（消除跨測試檔的車輛順序耦合）。
  await admin.query(`DELETE FROM resource_bookings WHERE workspace_id=$1`, [WS]);
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE '%公務車%'`, [WS]);
  // 清掉先前測試累積的未來事件（2027+），否則 attendee 會被誤判為忙 → 找不到空檔。
  // seed 的示範事件在 2026-09，不受影響。
  await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND start_utc >= '2027-01-01'`, [WS]);
  // 公務車（equipment + 名稱含「公務車」→ 需交接資源）
  VEHICLE = (
    await admin.query(
      `INSERT INTO resources(workspace_id,name,type) VALUES($1,'CommitteeVehicle-公務車','equipment') RETURNING id`,
      [WS],
    )
  ).rows[0].id;
  await admin.end();
});

const agentAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
  sub: MEM,
  workspace: WS,
  roles: ["scheduler"],
  scope: ["availability.read", "event.write", "resource.book"],
  ...over,
});

/** stub 模型：Coordinator 解析出 attendee=Bob + 公務車需求。 */
function bobVehicleModel(): ChatModel {
  return {
    async invokeStructured<T>(_schema: z.ZodType<T>, _messages: ChatMessage[]): Promise<T> {
      return { attendee_ids: [MEM2], unresolved_names: [], resources: [{ kind: "vehicle" }] } as T;
    },
  };
}

async function auditCounts(action: string, targetId?: string) {
  const admin = adminClient();
  await admin.connect();
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE workspace_id=$1 AND action=$2
       ${targetId ? "AND target_id=$3" : ""}`,
    targetId ? [WS, action, targetId] : [WS, action],
  );
  await admin.end();
  return r.rows[0].n as number;
}

describe("Committee 整合：借公務車完成預約 (E.4)", () => {
  it("confirm=true → booked，寫參與者/含 buffer 的 booking/自動提醒/稽核", async () => {
    const before = await auditCounts("committee.decision");
    const res = await toolDelegateComplexScheduling(
      agentAuth(),
      {
        task_description: `幫我跟 ${BOB_NAME} 借一輛公務車去拜訪客戶，2027-09-01 下午 2 點，1 小時`,
        reference_now_utc: "2026-09-15T00:00:00Z",
        default_timezone: "UTC",
        confirm: true,
        calendar_id: CAL,
        title: "客戶拜訪",
      },
      { model: bobVehicleModel() },
    );

    expect(res.status).toBe("booked");
    const result = res.result as {
      event: { id: string; source: string; start_utc: string; end_utc: string };
      booking: { id: string; start_utc: string; end_utc: string; resource_id: string };
      actual_usage: { start_utc: string; end_utc: string };
      reminders: Array<{ lead_minutes: number; channel: string }>;
    };
    expect(result.event.source).toBe("agent");
    expect(result.booking.resource_id).toBe(VEHICLE);

    // booking 區間含 buffer（比 actual_usage 各外擴 15 分鐘）
    const bufMs = 15 * 60_000;
    expect(Date.parse(result.actual_usage.start_utc) - Date.parse(result.booking.start_utc)).toBe(bufMs);
    expect(Date.parse(result.booking.end_utc) - Date.parse(result.actual_usage.end_utc)).toBe(bufMs);

    // 自動掛公務車提醒（會前 30 分 email）
    expect(result.reminders.length).toBe(1);
    expect(result.reminders[0].lead_minutes).toBe(30);
    expect(result.reminders[0].channel).toBe("email");

    // DB 驗證：event_participants 寫了 Bob，audit 有 commit + decision
    const admin = adminClient();
    await admin.connect();
    const parts = await admin.query(
      `SELECT member_id FROM event_participants WHERE workspace_id=$1 AND event_id=$2`,
      [WS, result.event.id],
    );
    await admin.end();
    expect(parts.rows.some((p) => p.member_id === MEM2)).toBe(true);

    expect(await auditCounts("committee.commit", result.event.id)).toBeGreaterThan(0);
    expect(await auditCounts("committee.decision")).toBeGreaterThan(before);
  });

  it("confirm=false → needs_decision + 預覽，不落實", async () => {
    const beforeEvents = await eventCount();
    const res = await toolDelegateComplexScheduling(
      agentAuth(),
      {
        task_description: `跟 ${BOB_NAME} 借公務車，2027-09-02 上午 10 點`,
        reference_now_utc: "2026-09-15T00:00:00Z",
        default_timezone: "UTC",
        confirm: false,
        calendar_id: CAL,
      },
      { model: bobVehicleModel() },
    );
    expect(res.status).toBe("needs_decision");
    expect(res.require_confirmation).toBe(true);
    expect(await eventCount()).toBe(beforeEvents); // 未落實
  });
});

async function eventCount() {
  const admin = adminClient();
  await admin.connect();
  const r = await admin.query(`SELECT count(*)::int AS n FROM events WHERE workspace_id=$1`, [WS]);
  await admin.end();
  return r.rows[0].n as number;
}

describe("Committee 零信任 (E.5)", () => {
  it("缺 resource.book scope → insufficient_scope", async () => {
    await expect(
      toolDelegateComplexScheduling(
        agentAuth({ scope: ["availability.read", "event.write"] }),
        { task_description: "x", confirm: true },
        { model: bobVehicleModel() },
      ),
    ).rejects.toMatchObject({ kind: "insufficient_scope" });
  });

  it("無 token → unauthorized", async () => {
    await expect(
      toolDelegateComplexScheduling(null, { task_description: "x" }, { model: bobVehicleModel() }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("被撤銷的 agent → forbidden", async () => {
    await revokeAgent(WS, "agent-committee-revoked");
    try {
      await expect(
        toolDelegateComplexScheduling(
          agentAuth({ sub: "agent-committee-revoked" }),
          { task_description: "x", confirm: true },
          { model: bobVehicleModel() },
        ),
      ).rejects.toMatchObject({ kind: "forbidden" });
    } finally {
      await unrevokeAgent(WS, "agent-committee-revoked");
    }
  });

  it("NL 內夾帶他 workspace 字樣不生效（workspace 只來自 token, ZT-5）", async () => {
    const res = await toolDelegateComplexScheduling(
      agentAuth(),
      {
        task_description: `在 workspace ${WS_B} 幫我跟 ${BOB_NAME} 借公務車 2027-09-03 下午 3 點`,
        reference_now_utc: "2026-09-15T00:00:00Z",
        default_timezone: "UTC",
        confirm: true,
        calendar_id: CAL,
      },
      { model: bobVehicleModel() },
    );
    expect(res.status).toBe("booked");
    // 事件建在 token 的 workspace（WS），不是 NL 指定的 WS_B
    const admin = adminClient();
    await admin.connect();
    const inB = await admin.query(
      `SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND title LIKE '%workspace%'`,
      [WS_B],
    );
    await admin.end();
    expect(inB.rows[0].n).toBe(0);
  });
});

describe("Committee explain / dry-run (E.8)", () => {
  it("explain=true → 回 trace 且 DB 無任何寫入", async () => {
    const beforeEvents = await eventCount();
    const beforeCommit = await auditCounts("committee.commit");
    const res = await toolDelegateComplexScheduling(
      agentAuth(),
      {
        task_description: `跟 ${BOB_NAME} 借公務車 2027-09-04 下午 1 點`,
        reference_now_utc: "2026-09-15T00:00:00Z",
        default_timezone: "UTC",
        explain: true,
        confirm: true, // explain 優先，仍不落實
        calendar_id: CAL,
      },
      { model: bobVehicleModel() },
    );
    expect(res.explain).toBe(true);
    expect(Array.isArray(res.trace)).toBe(true);
    expect((res.trace ?? []).length).toBeGreaterThan(0);
    // 無事件寫入、無 commit 稽核
    expect(await eventCount()).toBe(beforeEvents);
    expect(await auditCounts("committee.commit")).toBe(beforeCommit);
  });
});

describe("Committee 原子性 (E.7)", () => {
  it("booking 競態失敗 → 整筆 rollback（事件/參與者/提醒皆無殘留）", async () => {
    // 先佔用公務車在該時段（含 buffer 區間），使委員會落實時 EXCLUDE gist 命中。
    // 目標時段 2027-09-05 09:00-10:00，buffer 後寫入 08:45-10:15 → 預先塞一筆重疊 booking。
    const admin = adminClient();
    await admin.connect();
    const ev = (
      await admin.query(
        `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by,source)
         VALUES($1,$2,'RaceHolder','2027-09-05T09:00:00Z','2027-09-05T10:00:00Z','UTC',$3,'app') RETURNING id`,
        [WS, CAL, MEM],
      )
    ).rows[0].id;
    await admin.query(
      `INSERT INTO resource_bookings(workspace_id,resource_id,event_id,start_utc,end_utc)
       VALUES($1,$2,$3,'2027-09-05T08:50:00Z','2027-09-05T10:10:00Z')`,
      [WS, VEHICLE, ev],
    );
    const beforeEvents = await eventCount();
    await admin.end();

    // 因為預先占用會讓 resourceManager 的 buffer 判定就先擋下 → needs_decision（非落實）。
    // 為專門觸發「落實時競態」，直接呼叫 commitSchedulingPlan 驗證 rollback。
    const { commitSchedulingPlan, SchedulingCommitError } = await import("../src/agents/service.js");
    await expect(
      commitSchedulingPlan(agentAuth(), {
        calendar_id: CAL,
        title: "RaceCommit",
        timezone: "UTC",
        actual_start_utc: "2027-09-05T09:00:00Z",
        actual_end_utc: "2027-09-05T10:00:00Z",
        attendees: [MEM2],
        resource_id: VEHICLE,
        booking_start_utc: "2027-09-05T08:45:00Z",
        booking_end_utc: "2027-09-05T10:15:00Z",
        needs_handover: true,
      }),
    ).rejects.toBeInstanceOf(SchedulingCommitError);

    // rollback：沒有新增 RaceCommit 事件、沒有其參與者/提醒殘留
    const admin2 = adminClient();
    await admin2.connect();
    const leftover = await admin2.query(
      `SELECT id FROM events WHERE workspace_id=$1 AND title='RaceCommit'`,
      [WS],
    );
    await admin2.end();
    expect(leftover.rows.length).toBe(0);
    expect(await eventCount()).toBe(beforeEvents);
  });
});
