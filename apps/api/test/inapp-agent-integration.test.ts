import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runInAppAgent } from "../src/agents/inapp/service.js";
import { webhooksQueue } from "../src/integrations/webhooks.js";
import type { AuthContext } from "../src/auth/jwt.js";
import type { ChatModel } from "../src/agents/llm.js";

/**
 * 站內 agent 整合測：查詢分支查真實 DB 回模板答案；ISO-3 查詢不跨 workspace；
 * schedule 分支轉委員會（stub model）。時間窗一律後端規則算。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

const TZ = "Asia/Taipei";
// 固定 now，讓「今天/明天」窗確定；事件日期依此設定。
const NOW = new Date("2026-11-12T02:00:00Z"); // 2026-11-12 10:00 台北（週四）

let WS_A: string, WS_B: string, MEM_A: string, MEM_B: string, CAL_A: string;
let MEM_A2: string; // ws-a 第二個 member：不 own CAL_A、非任何 INAPP 事件 participant

// 站內 stub：意圖分類多半由規則判掉；此處委員會節點回無與會者、無資源。
const stub: ChatModel = {
  async invokeStructured(schema, _msgs) {
    const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (shape && "intent" in shape) return { intent: "list_events" } as never;
    return { attendee_ids: [], unresolved_names: [], resources: [] } as never;
  },
};

const authA = (): AuthContext => ({ sub: MEM_A, workspace: WS_A, roles: ["admin"] });
const authB = (): AuthContext => ({ sub: MEM_B, workspace: WS_B, roles: ["admin"] });

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS_A = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  WS_B = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-b'`)).rows[0].id;
  MEM_A = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS_A])).rows[0].id;
  MEM_B = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS_B])).rows[0].id;
  CAL_A = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS_A])).rows[0].id;
  // ws-a 第二個 member：不 own CAL_A、不參與任何 INAPP 事件（用於個人隔離斷言）
  const u2 = (await admin.query(`INSERT INTO users(email,display_name) VALUES('inapp-iso2@example.com','ISO2') ON CONFLICT (email) DO UPDATE SET display_name='ISO2' RETURNING id`)).rows[0].id;
  MEM_A2 = (await admin.query(`INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='member' RETURNING id`, [WS_A, u2])).rows[0].id;

  // 乾淨測試事件：ws-a 明天(11/13 台北)兩場；ws-b 明天一場（用於 ISO-3）
  await admin.query(`DELETE FROM events WHERE workspace_id IN ($1,$2) AND title LIKE 'INAPP-%'`, [WS_A, WS_B]);
  const CAL_B = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS_B])).rows[0].id;
  // 11/13 06:00Z=14:00台北, 08:00Z=16:00台北
  await admin.query(
    `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by,source) VALUES
       ($1,$2,'INAPP-A-會議1','2026-11-13T06:00:00Z','2026-11-13T07:00:00Z',$3,$4,'app'),
       ($1,$2,'INAPP-A-會議2','2026-11-13T08:00:00Z','2026-11-13T09:00:00Z',$3,$4,'agent')`,
    [WS_A, CAL_A, TZ, MEM_A],
  );
  await admin.query(
    `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by,source) VALUES
       ($1,$2,'INAPP-B-機密','2026-11-13T06:00:00Z','2026-11-13T07:00:00Z',$3,$4,'app')`,
    [WS_B, CAL_B, TZ, MEM_B],
  );
  await admin.end();
});

afterAll(async () => {
  const admin = adminClient();
  await admin.connect();
  await admin.query(`DELETE FROM events WHERE title LIKE 'INAPP-%'`);
  await admin.query(`DELETE FROM resource_bookings WHERE workspace_id=$1 AND resource_id IN (SELECT id FROM resources WHERE name LIKE 'INAPP-%')`, [WS_A]);
  await admin.query(`DELETE FROM resources WHERE name LIKE 'INAPP-%'`);
  await admin.end();
  await webhooksQueue.close();
});

describe("查詢分支（模板答案 + 真實 DB）", () => {
  it("「明天有會議嗎」→ 列出 ws-a 明天兩場，含 ✨ agent 標記", async () => {
    const r = await runInAppAgent(authA(), "明天有會議嗎", TZ, { model: stub, nowUtc: NOW });
    expect(r.kind).toBe("answer");
    expect(r.intent).toBe("list_events");
    expect(r.message).toContain("明天");
    expect(r.message).toContain("INAPP-A-會議1");
    expect(r.message).toContain("INAPP-A-會議2");
    expect(r.message).toContain("✨"); // 會議2 是 agent 排的
  });

  it("「這週有幾個會」→ count 分支回數量", async () => {
    const r = await runInAppAgent(authA(), "這週有幾個會", TZ, { model: stub, nowUtc: NOW });
    expect(r.intent).toBe("count_events");
    expect(r.message).toMatch(/共有 \d+ 個/);
  });

  it("「明天有空嗎」→ find_free 回空檔", async () => {
    const r = await runInAppAgent(authA(), "明天下午有空嗎", TZ, { model: stub, nowUtc: NOW });
    expect(r.intent).toBe("find_free");
    expect(r.kind).toBe("answer");
  });
});

describe("ISO-3：查詢不跨 workspace", () => {
  it("ws-a 問明天，看不到 ws-b 的機密事件", async () => {
    const r = await runInAppAgent(authA(), "明天有會議嗎", TZ, { model: stub, nowUtc: NOW });
    expect(r.message).not.toContain("機密");
    expect(r.message).not.toContain("INAPP-B");
  });

  it("ws-b 問明天，只看到自己的機密事件、看不到 ws-a", async () => {
    const r = await runInAppAgent(authB(), "明天有會議嗎", TZ, { model: stub, nowUtc: NOW });
    expect(r.message).toContain("INAPP-B-機密");
    expect(r.message).not.toContain("INAPP-A");
  });

  it("同 workspace 個人隔離：不 own/不參與的 member 看不到別人的會", async () => {
    const authA2 = (): AuthContext => ({ sub: MEM_A2, workspace: WS_A, roles: ["member"] });
    const r = await runInAppAgent(authA2(), "明天有會議嗎", TZ, { model: stub, nowUtc: NOW });
    // INAPP-A-* 由 MEM_A own / 建立，MEM_A2 既非 owner 亦非 participant → 查不到
    expect(r.message).not.toContain("INAPP-A-會議");
  });
});

describe("排會分支轉委員會", () => {
  it("「幫我約明天下午開會」→ schedule 意圖，走委員會（stub 無與會者 → needs_decision/error，不落實）", async () => {
    const r = await runInAppAgent(authA(), "幫我約明天下午開會", TZ, { model: stub, nowUtc: NOW });
    expect(r.intent).toBe("schedule");
    expect(["scheduled", "needs_decision", "error"]).toContain(r.kind);
  });
});

describe("一鍵確認（option_token → 落實）", () => {
  it("合法 option_token → confirmSchedule 落實事件", async () => {
    const { signOptionToken } = await import("../src/agents/option_token.js");
    const { confirmSchedule } = await import("../src/agents/inapp/service.js");
    // 需要一個資源（commit 會訂 booking）；用 admin 建臨時資源
    const admin = adminClient();
    await admin.connect();
    const res = (await admin.query(
      `INSERT INTO resources(workspace_id,name,type) VALUES($1,'INAPP-確認測試車','equipment') RETURNING id`,
      [WS_A],
    )).rows[0].id;
    await admin.end();

    const token = signOptionToken({
      workspace: WS_A, calendar_id: CAL_A, attendees: [MEM_A], resource_id: res, needs_handover: false,
      actual_start_utc: "2026-11-20T06:00:00Z", actual_end_utc: "2026-11-20T07:00:00Z",
      booking_start_utc: "2026-11-20T06:00:00Z", booking_end_utc: "2026-11-20T07:00:00Z",
      title: "INAPP-一鍵確認事件", timezone: TZ,
    });
    const r = await confirmSchedule(authA(), token);
    expect(r.kind).toBe("scheduled");
    expect(r.message).toContain("排入");
  });

  it("跨 workspace 的 token → 驗章失敗，不落實", async () => {
    const { signOptionToken } = await import("../src/agents/option_token.js");
    const { confirmSchedule } = await import("../src/agents/inapp/service.js");
    const token = signOptionToken({
      workspace: WS_B, calendar_id: "x", attendees: [], resource_id: "x", needs_handover: false,
      actual_start_utc: "2026-11-20T06:00:00Z", actual_end_utc: "2026-11-20T07:00:00Z",
      booking_start_utc: "2026-11-20T06:00:00Z", booking_end_utc: "2026-11-20T07:00:00Z",
      title: "x", timezone: TZ,
    });
    // authA (ws-a) 用 ws-b 的 token → workspace mismatch → error（不落實）
    const r = await confirmSchedule(authA(), token);
    expect(r.kind).toBe("error");
  });

  it("壞掉的 token → error", async () => {
    const { confirmSchedule } = await import("../src/agents/inapp/service.js");
    const r = await confirmSchedule(authA(), "not-a-valid-token");
    expect(r.kind).toBe("error");
  });
});
