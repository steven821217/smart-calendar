import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runInAppAgent, confirmAction } from "../src/agents/inapp/service.js";
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

// 站內 stub（離線/CI）：router schema 交給規則兜底（stub 無語意能力），
// 只服務委員會 coordinator schema。故對「含 intent 的 router schema」丟例外
// → routeMessage 走 rulesFallback（規則分類，行為等同真實 agent 在這些明確問句上的判斷）。
const stub: ChatModel = {
  async invokeStructured(schema, _msgs) {
    const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (shape && "intent" in shape) throw new Error("stub: no LLM routing, defer to rules");
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
  CAL_A = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS_A])).rows[0].id;
  // MEM_A 必須是 CAL_A 的擁有者，否則以 MEM_A 身分查詢時看不到建在 CAL_A 上的事件
  // （seed 累積多個 member 後，無 ORDER BY 的 LIMIT 1 會取到非擁有者，測試才會 flaky）。
  MEM_A = (await admin.query(`SELECT owner_id FROM calendars WHERE id=$1`, [CAL_A])).rows[0].owner_id;
  MEM_B = (await admin.query(`SELECT owner_id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS_B])).rows[0].owner_id;
  // ws-a 第二個 member：不 own CAL_A、不參與任何 INAPP 事件（用於個人隔離斷言）
  const u2 = (await admin.query(`INSERT INTO users(email,display_name) VALUES('inapp-iso2@example.com','ISO2') ON CONFLICT (email) DO UPDATE SET display_name='ISO2' RETURNING id`)).rows[0].id;
  MEM_A2 = (await admin.query(`INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='member' RETURNING id`, [WS_A, u2])).rows[0].id;
  // list_members 用群組：MEM_A 在「INAPP-隊」，MEM_A2 不在
  await admin.query(`DELETE FROM groups WHERE workspace_id=$1 AND name='INAPP-隊'`, [WS_A]);
  const gid = (await admin.query(`INSERT INTO groups(workspace_id,name,created_by) VALUES($1,'INAPP-隊',$2) RETURNING id`, [WS_A, MEM_A])).rows[0].id;
  const uA = (await admin.query(`SELECT user_id FROM memberships WHERE id=$1`, [MEM_A])).rows[0].user_id;
  await admin.query(`INSERT INTO group_members(workspace_id,group_id,user_id,role) VALUES($1,$2,$3,'leader') ON CONFLICT DO NOTHING`, [WS_A, gid, uA]);

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
  await admin.query(`DELETE FROM groups WHERE name='INAPP-隊'`);
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

describe("list_members（查團隊成員，個人隔離）", () => {
  it("「我的member有誰」→ 回團隊成員名單，而非會議清單", async () => {
    const r = await runInAppAgent(authA(), "我的member有誰", TZ, { model: stub, nowUtc: NOW });
    expect(r.intent).toBe("list_members");
    expect(r.message).toContain("INAPP-隊");
    expect(r.message).not.toContain("會議/行程"); // 不是誤判成 list_events
  });

  it("不屬於任何團隊的 member → 查不到別人的團隊成員", async () => {
    const authA2 = (): AuthContext => ({ sub: MEM_A2, workspace: WS_A, roles: ["member"] });
    const r = await runInAppAgent(authA2(), "我的組員是誰", TZ, { model: stub, nowUtc: NOW });
    expect(r.intent).toBe("list_members");
    expect(r.message).not.toContain("INAPP-隊"); // 隔離：不在該團隊就看不到
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

/**
 * Agent-first：第一層由 agent（此處以內容感知 stub 模擬 LLM）決定，
 * agent 選定的 intent 直接驅動「系統式回答」（查真實 DB 回模板），
 * 且不被規則覆蓋（via='agent'）。
 */
describe("agent-first：agent 決策驅動系統式回答（真實 DB）", () => {
  // 內容感知 stub：對 hierarchical family schema 與第二層 router schema分別回答；其餘（委員會）回空。
  function agentModel(route: Record<string, unknown>): ChatModel {
    return {
      async invokeStructured(schema, _msgs) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "family" in shape) {
          const i = String(route.intent ?? "list_events");
          const family = i === "find_free" ? "availability"
            : ["list_members", "events_with_person"].includes(i) ? "people"
              : ["count_events", "compare_load", "stats"].includes(i) ? "analytics"
                : ["schedule", "reschedule", "cancel", "respond_rsvp"].includes(i) ? "mutation"
                  : i === "out_of_scope" ? "out_of_scope" : "agenda";
          return {
            family, request_count: "one", secondary_family: null, confidence: "high", ambiguity: "none",
            requires_context: false, subject_scope: family === "people" ? "team" : "own", evidence_spans: [],
          } as never;
        }
        if (shape && "intent" in shape) return route as never;
        return { attendee_ids: [], unresolved_names: [], resources: [] } as never;
      },
    };
  }
  const ROUTE = {
    anchor: "none", weekday_from: null, weekday_to: null,
    daypart: "any", filter_keyword: null, group_name: null, order: "none",
    person_name: null, duration_minutes: null, search_range: "future",
  };

  it("agent 判 list_events + anchor=tomorrow → 觸發 DB 查詢，列出明天兩場", async () => {
    const model = agentModel({ intent: "list_events", ...ROUTE, anchor: "tomorrow" });
    const r = await runInAppAgent(authA(), "明天在大會議室的行程幫我看一下", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("agent");
    expect(r.message).toContain("INAPP-A-會議1");
    expect(r.message).toContain("INAPP-A-會議2");
  });

  it("agent 判 count_events → 觸發 count 系統答案（via='agent'）", async () => {
    const model = agentModel({ intent: "count_events", ...ROUTE, anchor: "tomorrow" });
    const r = await runInAppAgent(authA(), "明天的量大概多少", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("count_events");
    expect(r.via).toBe("agent");
    expect(r.message).toMatch(/共有 \d+ 個/);
  });

  it("agent 判 list_members（過去規則會誤判 list_events 的說法）→ 回成員名單", async () => {
    const model = agentModel({ intent: "list_members", ...ROUTE });
    // 「這組現在都由誰在跑」不含『有誰/成員』等關鍵字，舊規則會落到 list_events；agent 判得對。
    const r = await runInAppAgent(authA(), "這組現在都由誰在跑", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("list_members");
    expect(r.via).toBe("agent");
    expect(r.message).toContain("INAPP-隊");
    expect(r.message).not.toContain("會議/行程");
  });

  it("agent 判 schedule（無明確動詞、舊規則判不出）→ 轉委員會，不落實", async () => {
    const model = agentModel({ intent: "schedule", ...ROUTE });
    const r = await runInAppAgent(authA(), "明天下午想跟工程團隊碰個面討論進度", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("schedule");
    expect(["scheduled", "needs_decision", "error"]).toContain(r.kind);
  });

  it("ISO-3 仍成立：agent 路由下，ws-a 查不到 ws-b 機密", async () => {
    const model = agentModel({ intent: "list_events", ...ROUTE, anchor: "tomorrow" });
    const r = await runInAppAgent(authA(), "明天的行程", TZ, { model, nowUtc: NOW });
    expect(r.message).not.toContain("機密");
    expect(r.message).not.toContain("INAPP-B");
  });

  it("next_event：現在起最近一筆（跨窗）", async () => {
    const model = agentModel({ intent: "next_event", ...ROUTE });
    const r = await runInAppAgent(authA(), "我下一個行程是什麼", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("next_event");
    expect(r.message).toContain("INAPP-A-會議1");
  });

  it("event_detail：回地點/起訖/時長", async () => {
    const model = agentModel({ intent: "event_detail", ...ROUTE, anchor: "tomorrow", filter_keyword: "會議1" });
    const r = await runInAppAgent(authA(), "明天會議1的細節", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("event_detail");
    expect(r.message).toContain("INAPP-A-會議1");
    expect(r.message).toMatch(/分鐘/);
  });

  it("search_events：不限窗依關鍵字找", async () => {
    const model = agentModel({ intent: "search_events", ...ROUTE, filter_keyword: "會議1", search_range: "all" });
    const r = await runInAppAgent(authA(), "有沒有排過會議1", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("search_events");
    expect(r.message).toContain("INAPP-A-會議1");
  });

  it("event_detail 尊重排序槽位：latest_one 取當日最後一筆而非最早", async () => {
    const model = agentModel({ intent: "event_detail", ...ROUTE, anchor: "tomorrow", order: "latest_one" });
    const r = await runInAppAgent(authA(), "明天壓軸那場叫什麼", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("event_detail");
    expect(r.message).toContain("INAPP-A-會議2");
  });

  it("回指句不得用語意重排猜事件：沒有前文就請使用者補名稱或日期", async () => {
    const model = agentModel({ intent: "event_detail", ...ROUTE, filter_keyword: "上次講" });
    const r = await runInAppAgent(authA(), "上次講的那件事在哪處理", TZ, { model, nowUtc: NOW });
    expect(r.kind).toBe("needs_clarification");
    expect(r.message).toMatch(/沒有前文|補上行程名稱/);
  });

  it("out_of_scope：非日曆問題直接擋掉（不查 DB、固定訊息）", async () => {
    const model = agentModel({ intent: "out_of_scope", ...ROUTE });
    const r = await runInAppAgent(authA(), "今天天氣如何", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("out_of_scope");
    expect(r.message).toContain("日曆助理");
    expect(r.message).not.toContain("INAPP");
  });

  it("stats：回總數與時段分布", async () => {
    const model = agentModel({ intent: "stats", ...ROUTE, anchor: "this_month" });
    const r = await runInAppAgent(authA(), "我最忙星期幾", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("stats");
    expect(r.message).toMatch(/共有 \d+ 個/);
  });

  it("compare_load：回兩窗數量對比", async () => {
    const model = agentModel({ intent: "compare_load", ...ROUTE, anchor: "this_week" });
    const r = await runInAppAgent(authA(), "這週比上週忙嗎", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("compare_load");
    expect(r.message).toMatch(/個行程/);
  });
});

describe("第三波：破壞性動作（兩步確認，站內 only）", () => {
  function agentModel(route: Record<string, unknown>): ChatModel {
    return {
      async invokeStructured(schema, _msgs) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "family" in shape) {
          const i = String(route.intent ?? "list_events");
          const family = ["schedule", "reschedule", "cancel", "respond_rsvp"].includes(i) ? "mutation" : "agenda";
          return {
            family, request_count: "one", secondary_family: null, confidence: "high", ambiguity: "none",
            requires_context: false, subject_scope: "own", evidence_spans: [],
          } as never;
        }
        if (shape && "intent" in shape) return route as never;
        return { attendee_ids: [], unresolved_names: [], resources: [] } as never;
      },
    };
  }
  const ROUTE = {
    anchor: "none", weekday_from: null, weekday_to: null, daypart: "any",
    filter_keyword: null, group_name: null, order: "none",
    person_name: null, duration_minutes: null, search_range: "future",
    to_anchor: null, to_weekday: null, to_daypart: "any", edit_scope: "this", rsvp_decision: null,
  };

  it("cancel 第一步：回 needs_confirmation + action_token，不落實", async () => {
    const model = agentModel({ intent: "cancel", ...ROUTE, anchor: "tomorrow", filter_keyword: "會議1" });
    const r = await runInAppAgent(authA(), "取消明天的會議1", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("cancel");
    expect(r.kind).toBe("needs_confirmation");
    expect((r.data as { action_token?: string }).action_token).toBeTruthy();
    expect(r.message).toContain("無法復原");
    // 未落實：事件仍在（用另一個 list 查詢確認）
    const still = await runInAppAgent(authA(), "明天有會議嗎", TZ, { model: agentModel({ intent: "list_events", ...ROUTE, anchor: "tomorrow" }), nowUtc: NOW });
    expect(still.message).toContain("INAPP-A-會議1");
  });

  it("reschedule 第一步：需要新時間才回確認；無新時間 → 追問", async () => {
    const model = agentModel({ intent: "reschedule", ...ROUTE, anchor: "tomorrow", filter_keyword: "會議1" });
    const r = await runInAppAgent(authA(), "把明天的會議1改一下", TZ, { model, nowUtc: NOW });
    expect(r.intent).toBe("reschedule");
    // 沒給 to_anchor → 追問新時間（answer），不是 needs_confirmation
    expect(r.kind).toBe("answer");
    expect(r.message).toMatch(/什麼時候|新的/);
  });

  it("reschedule 第一步（含新時間）→ needs_confirmation + token", async () => {
    const model = agentModel({ intent: "reschedule", ...ROUTE, anchor: "tomorrow", filter_keyword: "會議1", to_anchor: "day_after_tomorrow", to_daypart: "morning" });
    const r = await runInAppAgent(authA(), "把明天的會議1改到後天早上", TZ, { model, nowUtc: NOW });
    expect(r.kind).toBe("needs_confirmation");
    expect((r.data as { action_token?: string }).action_token).toBeTruthy();
  });

  it("confirmAction：帶偽造/失效 token → error（不落實）", async () => {
    const r = await confirmAction(authA(), "bogus.token", TZ);
    expect(r.kind).toBe("error");
  });

  it("readOnly（外部 agent）：回覆邀請意圖在**執行前**被擋，rsvp_status 不得被改", async () => {
    // 先造一筆待回覆邀請：authA 以外的成員建會並邀 authA
    const c = adminClient();
    await c.connect();
    const ws = WS_A;
    const ev = (
      await c.query(
        `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by)
         VALUES($1,$2,'RO-邀請測試會',now()+interval '2 day',now()+interval '2 day' + interval '30 min','Asia/Taipei',$3)
         RETURNING id`,
        [ws, CAL_A, MEM_A],
      )
    ).rows[0].id as string;
    await c.query(
      `INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status) VALUES($1,$2,$3,'pending')`,
      [ws, ev, MEM_A],
    );

    const model = agentModel({ intent: "respond_rsvp", ...ROUTE, rsvp_decision: "accept", filter_keyword: "RO-邀請測試會" });
    const r = await runInAppAgent(authA(), "接受 RO-邀請測試會 的邀請", TZ, { model, nowUtc: NOW, readOnly: true });
    expect((r.data as { not_permitted?: boolean })?.not_permitted).toBe(true);
    expect(r.message).toContain("不支援修改行事曆");

    // 關鍵：資料庫狀態必須仍是 pending（舊實作會變成 accepted）
    const after = await c.query(
      `SELECT rsvp_status FROM event_participants WHERE event_id=$1 AND member_id=$2`,
      [ev, MEM_A],
    );
    await c.query(`DELETE FROM events WHERE id=$1`, [ev]);
    await c.end();
    expect(after.rows[0].rsvp_status).toBe("pending");
  });

  it("readOnly：排會意圖不觸發委員會，直接引導改用 delegate", async () => {
    const model = agentModel({ intent: "schedule", ...ROUTE, anchor: "tomorrow" });
    const r = await runInAppAgent(authA(), "幫我約明天下午開會", TZ, { model, nowUtc: NOW, readOnly: true });
    expect((r.data as { not_a_query?: boolean })?.not_a_query).toBe(true);
    expect(r.message).toContain("delegate_complex_scheduling");
  });

  it("改期不得落到過去：只給星期幾（本週該日已過）→ 自動推到下一週的同一天", async () => {
    // NOW 為週四；只給 to_weekday=0（週一）而無 to_anchor → 舊實作會退用 this_week
    // 算出「本週一」＝已過的日期（實測 9/20 的事件被改到 9/14）。
    const model = agentModel({
      intent: "reschedule", ...ROUTE, anchor: "tomorrow", filter_keyword: "會議1",
      to_weekday: 0, to_daypart: "afternoon",
    });
    const r = await runInAppAgent(authA(), "把明天的會議1改到週一下午", TZ, { model, nowUtc: NOW });
    expect(r.kind).toBe("needs_confirmation");
    const preview = (r.data as { preview?: { to?: string } }).preview;
    expect(preview?.to).toBeTruthy();
    expect(new Date(preview!.to!).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("明確指定『今天』但該時段已過 → 不擅自跳一週，改為追問新時間", async () => {
    // NOW 為當地 10:00；指定 to_anchor=today + 早上（10:00）→ 已過 → 應追問而非亂跳
    const model = agentModel({
      intent: "reschedule", ...ROUTE, anchor: "tomorrow", filter_keyword: "會議1",
      to_anchor: "today", to_daypart: "morning",
    });
    const r = await runInAppAgent(authA(), "把明天的會議1改到今天早上", TZ, { model, nowUtc: NOW });
    expect(r.kind).toBe("answer");
    expect(r.message).toMatch(/什麼時候|新的/);
  });
});


describe("Planner → specialists → Composer（複合需求）", () => {
  const BASE_ROUTE = {
    anchor: "none", weekday_from: null, weekday_to: null, daypart: "any",
    filter_keyword: null, group_name: null, order: "none", person_name: null,
    duration_minutes: null, search_range: "future", to_anchor: null, to_weekday: null,
    to_daypart: "any", edit_scope: "this", rsvp_decision: null,
    confidence: "high", ambiguity: "none", secondary_intent: null,
    filter_kind: "none", evidence_spans: [],
  };

  function plannerModel(writeSecond = false): ChatModel {
    return {
      async invokeStructured(schema, msgs) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        const text = msgs.find((m) => m.role === "human")?.content ?? "";
        if (shape && "tasks" in shape) {
          return {
            tasks: writeSecond
              ? [
                  { request: "列出明天有哪些會議", family: "agenda", subject_scope: "own", evidence_spans: ["明天有哪些會議"] },
                  { request: "取消會議1", family: "mutation", subject_scope: "own", evidence_spans: ["取消會議1"] },
                ]
              : [
                  { request: "列出明天有哪些會議", family: "agenda", subject_scope: "own", evidence_spans: ["明天有哪些會議"] },
                  { request: "INAPP-隊有哪些人", family: "people", subject_scope: "team", evidence_spans: ["INAPP-隊有哪些人"] },
                ],
          } as never;
        }
        if (shape && "family" in shape) {
          if (text.includes("同時") || text.includes("然後")) return {
            family: "agenda", request_count: "multiple", confidence: "high", requires_context: false,
            subject_scope: "own", evidence_spans: writeSecond
              ? ["明天有哪些會議", "取消會議1"]
              : ["明天有哪些會議", "INAPP-隊有哪些人"],
          } as never;
          const family = text.includes("哪些人") ? "people" : text.includes("取消") ? "mutation" : "agenda";
          return {
            family, request_count: "one", confidence: "high", requires_context: false,
            subject_scope: family === "people" ? "team" : "own", evidence_spans: [text],
          } as never;
        }
        if (shape && "intent" in shape) {
          if (text.includes("哪些人")) return { ...BASE_ROUTE, intent: "list_members", group_name: "INAPP-隊" } as never;
          if (text.includes("取消")) return { ...BASE_ROUTE, intent: "cancel", filter_keyword: "會議1", filter_kind: "event_subject" } as never;
          return { ...BASE_ROUTE, intent: "list_events", anchor: "tomorrow" } as never;
        }
        return { attendee_ids: [], unresolved_names: [], resources: [] } as never;
      },
    };
  }

  it("兩個唯讀子任務各走 specialist，Composer 同時保留兩邊事實", async () => {
    const r = await runInAppAgent(
      authA(),
      "請列出明天有哪些會議，同時告訴我 INAPP-隊有哪些人",
      TZ,
      { model: plannerModel(), nowUtc: NOW },
    );
    expect(r.kind).toBe("answer");
    expect(r.intent).toBe("multiple");
    expect(r.via).toBe("agent-plan+specialists+composer");
    expect(r.message).toContain("INAPP-A-會議1");
    expect(r.message).toContain("INAPP-隊");
  });

  it("計畫中含寫入時先整體攔截，不執行任何子任務或產生確認 token", async () => {
    const r = await runInAppAgent(
      authA(),
      "先列出明天有哪些會議，然後取消會議1",
      TZ,
      { model: plannerModel(true), nowUtc: NOW },
    );
    expect(r.kind).toBe("needs_clarification");
    expect(r.message).toContain("同時包含查詢與修改");
    expect(JSON.stringify(r.data ?? {})).not.toContain("action_token");
  });
});
