/**
 * 外部 agent 協作入口：讓呼叫端把「理解」的部分自己做完。
 *
 * 背景：本地路由用的是 14B，理解能力有限；外部 agent（Claude / GPT 級別）理解能力強得多，
 * 但沒有資料。與其讓強模型把問題丟給弱模型重新理解一次（雙重損失：延遲 + 準確度），
 * 不如讓強模型直接送出「它已經理解好的查詢」，本地只負責資料與政策。
 *
 * 對應文獻：
 *  - Google A2A（2025-04，現由 Linux Foundation Agentic AI Foundation 治理）把 agent 間互動
 *    定義為「能力宣告 + 任務委派」，而不是把對方當成無狀態工具。
 *  - arXiv:2608.22063《A Domain-Oriented Pattern for MCP Servers》：MCP server 應暴露
 *    **領域操作**而非原始 schema。因此這裡開放的是我們的查詢語意（intent + 槽位），
 *    不是資料庫欄位。
 *
 * 安全邊界完全不變：RLS、個人隔離、唯讀、寫入需站內確認都在本地強制，
 * 呼叫端再聰明也只能看到自己的行程。
 */
import { z } from "zod";
import type { RouteResult } from "../agents/inapp/router.js";
import { normalizeSpec } from "../agents/inapp/query-spec.js";
import { normalizeSemanticAssessment } from "../agents/inapp/semantic-harness.js";

/** 外部 agent 可直接指定的查詢意圖（唯讀；寫入類一律不開放）。 */
export const ExternalIntentSchema = z
  .enum([
    "list_events",
    "count_events",
    "find_free",
    "list_pending",
    "list_members",
    "next_event",
    "event_detail",
    "search_events",
    "events_with_person",
    "compare_load",
    "stats",
  ])
  .describe(
    // 每個 intent「會回什麼」必須寫清楚：實測 minimax-m2.1 因為不知道 event_detail 會回
    // 與會者名單，直接回答「無法確認參與者」；也因為不知道 list_pending 存在，
    // 自己發明了不存在的 rsvp_decision 參數。
    "要執行哪一種查詢：\n" +
    "list_events=時間窗內的行程清單（回 facts.events：標題/起訖/地點）\n" +
    "count_events=時間窗內的行程數量（回 facts.count）\n" +
    "find_free=可用空檔（回 facts.free_slots；未指定 duration_minutes 時回合併後的連續區間）\n" +
    "list_pending=別人發起、還在等我回覆的邀請（**要查待回覆就用這個**，不要自己造參數）\n" +
    "list_members=團隊成員名單與人數（搭配 group_name；不給就回全部可見團隊）\n" +
    "next_event=從現在起最近一筆\n" +
    "event_detail=單一行程的完整細節（**含 attendees 與會者名單、duration_minutes、location、description**，搭配 filter_keyword 指定哪一場）\n" +
    "search_events=依關鍵字找行程（filter_keyword 同時比對標題與地點，搭配 search_range='all' 可跨過去未來）\n" +
    "events_with_person=我與某人的共同行程（搭配 person_name，需與 workspace 成員姓名相符）\n" +
    "compare_load=兩個期間的忙碌程度對比\n" +
    "stats=期間內的統計分布（最忙星期幾、時段分布）",
  );

/**
 * 外部 agent 送來的查詢計畫。所有欄位可選，未給的以中性預設補齊，
 * 因此呼叫端只需要指定它真正確定的部分（漸進式，不必學完整 schema）。
 */
export const ExternalPlanSchema = z.object({
  intent: ExternalIntentSchema,
  anchor: z
    .enum(["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "last_week", "this_month", "next_month", "none"])
    .optional()
    .describe("相對日期錨點；要用星期就填 weekday_from/to"),
  weekday_from: z.number().int().min(0).max(6).nullish().describe("週一=0"),
  weekday_to: z.number().int().min(0).max(6).nullish(),
  daypart: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
  filter_keyword: z.string().max(60).nullish().describe("行程標題或地點關鍵字"),
  group_name: z.string().max(60).nullish().describe("團隊名稱（需與 workspace 既有名稱相符）"),
  person_name: z.string().max(60).nullish().describe("共同行程的對象姓名"),
  duration_minutes: z.number().int().min(15).max(600).nullish().describe("找空檔時需要的長度"),
  order: z.enum(["first", "last", "next", "none"]).optional(),
  search_range: z.enum(["future", "past", "all"]).optional(),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .describe("絕對日期（本地時區 yyyy-mm-dd）。要查「某一天」就用這個，不必勉強套相對錨點"),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .describe("絕對日期範圍的結束日（含）；只給 date_from 就是單日"),
});

export type ExternalPlan = z.infer<typeof ExternalPlanSchema>;

/** 查詢意圖 → QuerySpec 的內部 intent。 */
const SPEC_INTENT_FOR: Record<string, "list" | "count" | "find_free" | "pending"> = {
  list_events: "list",
  count_events: "count",
  find_free: "find_free",
  list_pending: "pending",
  list_members: "list",
  next_event: "list",
  event_detail: "list",
  search_events: "list",
  events_with_person: "list",
  compare_load: "count",
  stats: "count",
};

/**
 * 把外部計畫轉成本地執行用的 RouteResult。
 * via 標成 external-plan，讓稽核與評測能區分「這個答案的理解來自外部 agent」。
 */
export function routeFromExternalPlan(plan: ExternalPlan, question: string): RouteResult {
  const spec = normalizeSpec({
    intent: SPEC_INTENT_FOR[plan.intent] ?? "list",
    anchor: plan.anchor ?? "none",
    weekday_from: plan.weekday_from ?? null,
    weekday_to: plan.weekday_to ?? null,
    daypart: plan.daypart ?? "any",
    filter_keyword: plan.filter_keyword ?? null,
    group_name: plan.group_name ?? null,
    order: plan.order ?? "none",
    person_name: plan.person_name ?? null,
    duration_minutes: plan.duration_minutes ?? null,
    search_range: plan.search_range ?? "future",
    date_from: plan.date_from ?? null,
    date_to: plan.date_to ?? null,
  });
  return {
    intent: plan.intent,
    spec,
    via: "external-plan",
    semantic: normalizeSemanticAssessment(
      {
        // 外部 agent 的理解視為高信心：它比本地 14B 強，且它自己會覆核
        confidence: "high",
        ambiguity: "clear",
        subject_scope: plan.person_name ? "shared_with_person" : plan.group_name ? "team" : "own",
        requires_context: false,
        filter_kind: plan.filter_keyword ? "event_subject" : "none",
        evidence_spans: [],
      },
      question,
      plan.intent,
    ),
  };
}
