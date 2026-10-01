import { z } from "zod";
import type { ChatModel } from "../llm.js";
import { classifyByRules, type Intent } from "./intent.js";
import { normalizeSpec, reconcileSpec, type QuerySpec, subjectKeywordFromText } from "./query-spec.js";
import {
  applySemanticSpecContract,
  canonicalizePrimaryIntent,
  discourseSignals,
  explicitlyDeclinesCalendarLookup,
  normalizeSemanticAssessment,
  type RouteFamily,
  type SemanticAssessment,
} from "./semantic-harness.js";
import { getCachedRoute, setCachedRoute } from "./route-cache.js";
import { formatFamilyExamples, retrieveFamilyExamples } from "./icl-retrieval.js";
import { clauseSegments, looksCompositional } from "./clause-split.js";
import { fastPathIntent } from "./cascade.js";

/**
 * Agent-first routing（第一層一律由 agent 決定）。
 *
 * 設計原則（依使用者要求）：
 *  - **不讓前端/規則硬判定使用者問句**。第一層路由一律先問 agent（LLM），由 agent
 *    在「同一次結構化呼叫」裡同時決定 intent 與查詢參數（anchor/weekday/daypart/
 *    keyword/group/order）。「系統式回答」（查 DB 回模板）仍然存在，但那是 agent
 *    想過後選擇觸發的分支，而非規則先替它決定。
 *  - 規則**只在 LLM 不可用時**兜底（離線 / CI / 金鑰缺失），確保絕不卡死；此時
 *    via='rules-fallback'，與正常 via='agent' 明確區分，方便觀測誤判來源。
 *  - 時間 / 群組覆核仍由後端做，但只作用在「agent 自己的輸出」上（安全網），
 *    不再拿規則覆蓋 agent 選定的 intent。
 *
 * 回傳的 QuerySpec.intent 用查詢語彙（list/count/find_free/pending），另加兩個站內
 * 專屬意圖 schedule / list_members，故此處用較寬的 RouteIntent。
 */

export type RouteIntent = Intent; // list_events | count_events | find_free | list_pending | list_members | schedule

export interface PlannedSubtask {
  request: string;
  family: RouteFamily;
  subject_scope: "own" | "shared_with_person" | "team" | "other_person_private" | "none";
}

export interface RouteResult {
  intent: RouteIntent;
  /** 查詢類意圖附帶的參數（schedule / list_members 時可忽略）。 */
  spec: QuerySpec;
  /** 決策來源：agent = LLM 決定；agent+backstop = agent 判完再由高精度規則覆核；rules-fallback = LLM 不可用時兜底。 */
  via: "agent" | "agent+backstop" | "rules-fallback" | "rules-cascade" | "external-plan";
  /** Planner 產生的獨立 typed subtasks；最多 3 個。service 先做全體 preflight 再逐一執行。 */
  subtasks?: PlannedSubtask[];
  /** 模型自評 + 經伺服器驗證的原文證據；舊快取/測試 fixture 可沒有。 */
  semantic?: SemanticAssessment;
}


interface RouteOptions {
  forcedFamily?: RouteFamily;
  forcedSubjectScope?: PlannedSubtask["subject_scope"];
  skipPlanning?: boolean;
  /** 本 workspace 成員姓名：讓路由確定性辨認人名，不依賴 14B 填 person_name。 */
  people?: string[];
}
/** Agent 一次到位的路由 schema：先選 intent，查詢類再帶查詢參數。 */
const RouteSchema = z.object({
  intent: z
    .enum([
      "list_events",
      "count_events",
      "find_free",
      "list_pending",
      "list_members",
      "schedule",
      "next_event",
      "event_detail",
      "search_events",
      "events_with_person",
      "compare_load",
      "stats",
      "reschedule",
      "cancel",
      "respond_rsvp",
      "out_of_scope",
    ])
    .describe(
      "使用者意圖：list_events=查某時段有哪些會；count_events=問數量/忙不忙；find_free=找空檔；" +
        "list_pending=待回覆邀請；list_members=問團隊有哪些成員；schedule=要求安排/預約新的會；" +
        "next_event=下一個/等一下要幹嘛；event_detail=某個會的地點/時長/與會者；" +
        "search_events=不限時間找標題含關鍵字的會；events_with_person=我跟某人有沒有約；" +
        "compare_load=比較兩時段忙碌；stats=統計如最忙星期幾；" +
        "reschedule=把某個既有的會改到別的時間；cancel=取消/刪除某個既有的會；" +
        "respond_rsvp=回覆（接受/婉拒）別人約我的邀請；out_of_scope=與日曆無關的問題。",
    ),
  anchor: z
    .enum(["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "last_week", "this_month", "next_month", "none"])
    .describe("時間錨點；未指明填 none。日期由後端算。"),
  weekday_from: z.number().int().min(0).max(6).nullable().describe("指定星期起（週一=0…週日=6），範圍如週三到週五填 2；否則 null"),
  weekday_to: z.number().int().min(0).max(6).nullable().describe("指定星期迄，單一星期與 from 相同，否則 null"),
  daypart: z.enum(["morning", "afternoon", "evening", "any"]).describe("下午=afternoon 上午=morning 晚上=evening 未指明=any"),
  filter_keyword: z.string().nullable().describe("『跟X的會』或搜尋關鍵字 X；否則 null"),
  requested_detail: z.enum(["location", "start_end", "duration", "attendees", "none"]).describe("使用者問單一事件的哪種細節；不是細節問題填 none"),
  count_target: z
    .enum(["events", "people", "none"])
    .describe("若問『幾個/幾位/多少』這類數量，明確指出數的對象：行程數=events、人數=people；不是數量問題=none"),
  group_name: z.string().nullable().describe("『X團隊/X小隊』整個當群組；否則 null"),
  order: z
    .enum(["all", "earliest_one", "latest_one", "next_one"])
    .describe("回答範圍：要完整清單或不確定=all（預設）；只要最早那一筆=earliest_one；只要最晚/壓軸那一筆=latest_one；只要從現在起下一筆=next_one。『依時間排序列出』『接下來還有什麼』仍是 all"),
  person_name: z.string().nullable().describe("events_with_person 提到的人名；否則 null"),
  duration_minutes: z.number().int().min(15).max(600).nullable().describe("find_free 指定時長分鐘（2小時=120）；否則 null"),
  search_range: z.enum(["future", "past", "all"]),
  to_anchor: z.enum(["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "none"]).nullable().describe("reschedule 改到哪天的錨點；否則 null"),
  to_weekday: z.number().int().min(0).max(6).nullable().describe("reschedule 改到週幾（週一=0…）；否則 null"),
  to_daypart: z.enum(["morning", "afternoon", "evening", "any"]).describe("reschedule 改到的時段；否則 any"),
  edit_scope: z.enum(["this", "this_and_future", "all"]).describe("reschedule/cancel 對重複事件的範圍：僅這次=this、這次以後=this_and_future、全部=all；未指明填 this"),
  rsvp_decision: z.enum(["accept", "decline"]).nullable().describe("respond_rsvp 的回覆：接受=accept、婉拒=decline；否則 null"),
  confidence: z.enum(["high", "medium", "low"]).describe("對主要意圖判斷的信心；明確要求=high、可合理推斷=medium、無法確定=low"),
  ambiguity: z
    .enum(["none", "missing_time", "missing_target", "unresolved_reference", "multiple_requests", "unclear"])
    .describe("語意是否缺資訊；不要用猜的。一般省略但仍可回答填 none"),
  secondary_intent: z
    .enum([
      "list_events", "count_events", "find_free", "list_pending", "list_members", "schedule",
      "next_event", "event_detail", "search_events", "events_with_person", "compare_load", "stats",
      "reschedule", "cancel", "respond_rsvp", "out_of_scope",
    ])
    .nullable()
    .describe("同一句若有第二個獨立需求則填；單一回答已涵蓋時填 null"),
  filter_kind: z
    .enum(["event_subject", "none"])
    .describe("filter_keyword 真的是事件名稱/主題才填 event_subject；命令動詞、語氣、行程泛稱、用途一律 none"),
  evidence_spans: z
    .array(z.string().min(1).max(80))
    .max(8)
    .describe("1–4 個直接支持意圖/時間/目標的最短原文片段；必須逐字出現在使用者訊息，不可改寫"),
});
type RouteRaw = z.infer<typeof RouteSchema>;


/**
 * 14B 分層路由第一層：只在 6 個能力家族中選一個；第二層才看該家族最多 5 個 function。
 * 相較一次暴露 16 個 intent，可降低 next/list/detail、stats/count 等相鄰工具互搶。
 */
const FAMILY_LABELS: Record<string, RouteFamily> = {
  existing_events: "agenda",
  free_time: "availability",
  team_or_person: "people",
  aggregate_stats: "analytics",
  modify_calendar: "mutation",
  not_calendar: "out_of_scope",
  // 舊 fixture / 快取相容
  agenda: "agenda",
  availability: "availability",
  people: "people",
  analytics: "analytics",
  mutation: "mutation",
  out_of_scope: "out_of_scope",
};

const FamilySchema = z.object({
  family: z
    .enum(["existing_events", "free_time", "team_or_person", "aggregate_stats", "modify_calendar", "not_calendar"])
    .describe("使用者要的是哪一種答案"),
  request_count: z.enum(["one", "multiple"]).describe("一個可由單一回答完成的目的=one；兩個以上獨立動作=multiple"),
  confidence: z.enum(["high", "medium", "low"]),
  requires_context: z.boolean().describe("句子用它/那場/之前那件等指涉，但本訊息無法單獨定位時 true"),
  subject_scope: z.enum(["own", "shared_with_person", "team", "other_person_private", "none"]),
});
/**
 * 第一層刻意**不要** evidence_spans：實測它讓輸出從 60 增到 73 tokens，
 * 在 30 tok/s 的本機 GPU 上等於每題多 0.5s；而第二層 specialist 仍逐字回報 evidence，
 * 證據 grounding 與觀測能力不受影響。
 */
type FamilyRaw = z.infer<typeof FamilySchema> & { evidence_spans?: string[] };

/**
 * Planner 只在第一層偵測到 multiple 時啟動。仿 claw-code 的有限 tool loop：硬上限 3，
 * 不讓 14B 自由遞迴。每個子需求必須可獨立交給既有 specialist route。
 */
const DecompositionSchema = z.object({
  tasks: z.array(z.object({
    request: z.string().min(1).max(240),
    family: z.enum(["agenda", "availability", "people", "analytics", "mutation", "out_of_scope"]),
    subject_scope: z.enum(["own", "shared_with_person", "team", "other_person_private", "none"]),
    evidence_spans: z.array(z.string().min(1).max(80)).min(1).max(4),
  })).min(1).max(3),
});

const DECOMPOSITION_SYSTEM =
  "你是日曆任務 Planner。把使用者一次提出的多個獨立目的拆成最多 3 個可單獨執行的日曆請求。" +
  "每個 task.request 必須是完整、獨立的一句話，保留原本的日期、時段、人物、群組、事件名稱和排序要求；不可新增原文沒有的需求。" +
  "同一目的的補充（例如名稱+時間、列表+總數）仍是一個 task，不可硬拆。" +
  "每個 task 同時指定 family：查既有行程/細節/搜尋/邀請=agenda；找空檔=availability；團隊或共同行程=people；數量/比較/統計=analytics；任何寫入=mutation；非日曆=out_of_scope。" +
  "subject_scope 依該子任務分別填 own/shared_with_person/team/other_person_private/none。" +
  "模糊片段要補成可獨立理解的請求，例如原句要求依序回答多天『安排』時，每個 task.request 應寫成『列出某日既有行程』，不可改成找空檔。" +
  "若使用者要求同一天的不同時段各自整理（例如上午一份、下午一份），就按時段拆成各自一個 task，並在 request 保留該日期與時段詞。" +
  "若其實只有一個目的，只回 1 個 task，讓 harness 撤銷誤判。" +
  "evidence_spans 必須逐字出現在原文，且直接支持該 task。不要解釋。";

const compactText = (value: string) => value.replace(/[\s，。、；;：:！!？?（）()「」『』"']/g, "");

/**
 * 證據 grounding：允許模型把原文成分重新組合（原句「明天上午和下午」→ 證據「明天下午」），
 * 但不得憑空新增內容。判準是「字元需依序出現在原文」——重組可過，幻想詞（出現原文沒有的字）
 * 必被擋下。實測 Planner 對「上午和下午分別列出」確實會輸出補全後的『明天下午』，
 * 若堅持逐字比對會把正確的多步計畫整批丟棄。
 */
function evidenceGrounded(span: string, original: string): boolean {
  const needle = compactText(span.trim());
  const hay = compactText(original);
  if (!needle) return false;
  if (hay.includes(needle)) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

function validPlannedTasks(original: string, raw: z.infer<typeof DecompositionSchema>): PlannedSubtask[] {
  const out: PlannedSubtask[] = [];
  for (const task of raw.tasks.slice(0, 3)) {
    const request = task.request.trim();
    const evidenceValid = task.evidence_spans.some((span) => evidenceGrounded(span, original));
    if (!request || !evidenceValid || out.some((item) => item.request === request)) continue;
    const family: RouteFamily = ["shared_with_person", "team"].includes(task.subject_scope)
      ? "people"
      : (FAMILY_LABELS[String(task.family)] ?? "agenda");
    out.push({ request, family, subject_scope: task.subject_scope });
  }
  return out;
}

const FAMILY_INTENTS: Record<RouteFamily, readonly RouteIntent[]> = {
  agenda: ["list_events", "next_event", "event_detail", "search_events", "list_pending"],
  availability: ["find_free"],
  people: ["list_members", "events_with_person"],
  analytics: ["count_events", "compare_load", "stats", "list_events", "list_members"],
  mutation: ["schedule", "reschedule", "cancel", "respond_rsvp"],
  out_of_scope: ["out_of_scope"],
};

const DEFAULT_FAMILY_INTENT: Record<RouteFamily, RouteIntent> = {
  agenda: "list_events",
  availability: "find_free",
  people: "list_members",
  analytics: "count_events",
  mutation: "schedule",
  out_of_scope: "out_of_scope",
};

const FAMILY_SYSTEM =
  "你是日曆助理的第一層路由器。這一層不選具體 function，只判斷使用者要哪一種答案：\n" +
  "- existing_events：想知道日曆上已經有什麼。包含某天有哪些行程、有沒有事、下一場、某一場的地點/起訖/時長/與會者、依名稱找行程、待回覆邀請。\n" +
  "- free_time：想知道還有哪段時間沒有行程，可以拿來安排或專心工作。\n" +
  "- team_or_person：想知道團隊有哪些成員、成員人數，或本人與某個人的共同行程。\n" +
  "- aggregate_stats：想知道行程的數量、忙碌程度比較、統計模式。\n" +
  "- modify_calendar：要求新增、改期、取消或回覆邀請。\n" +
  "- not_calendar：與日曆資料無關，例如撰寫/翻譯/潤飾會議講稿、簡報、標語。\n" +
  "關鍵對照（依語意判斷，不要只看單字）：\n" +
  "- 『有事嗎／有沒有行程／有安排嗎／還有什麼』= existing_events；『有空嗎／有空檔嗎／挪得出時間嗎』= free_time。\n" +
  "- 『某場會議有誰參加』= existing_events；『某團隊有哪些人／有幾個人／幾位成員』= team_or_person。\n" +
  "- 『行程有幾個／幾場』= aggregate_stats；『人有幾個』= team_or_person。\n" +
  "先理解整句目的，不靠單一字。錯字、口語、粵語、簡繁體、中英混用不改變目的。" +
  "request_count：可由一個回答完成就永遠是 one；要求名稱+時間、列表+總數、統計+場次都仍是 one。只有『另外/然後/也幫我』真的要求第二個獨立動作才是 multiple。" +
  "寒暄、情緒、天氣等背景、被『不用/不是/只要/先別管』否定或放棄的事項，都不是第二個目的。" +
  "requires_context 只在必須依賴前文才能知道哪個事件時填 true；『下一個行程』本身可定位，不需前文。" +
  "subject_scope：自己的日曆=own；我跟某人的共同事件=shared_with_person；團隊名單=team；要求看他人未分享/私人日曆=other_person_private；非日曆=none。" +

  "判斷對照：『替明天會議寫講稿，不用查日曆』是 out_of_scope/one；『明天有哪些會』是 agenda/one；" +
  "問『還有事嗎/有沒有行程/是不是有安排』要的是既有行程=agenda；只有問『有沒有空/空檔/能不能挪出時間』才是 availability。" +
  "『某場會議有誰參加』是 agenda（該場與會者）；『某團隊有哪些成員』才是 people。" +
  "問『團隊現在幾個人／幾位成員』是 people（數人）；只有數行程數量才是 analytics。" +
  "『週六兩點那場在哪』是 agenda/one；『先查週六行程，另外找空檔』的 request_count=multiple。";

const FAMILY_DETAIL_SYSTEM: Record<RouteFamily, string> = {
  agenda:
    "本層只處理行程閱讀：一段期間的全部/有無行程=list_events；真正的全域下一筆=next_event；" +
    "點名某場、某時刻那場並問地點/起訖/與會者=event_detail；忘記日期而依主題找=search_events；待答覆邀請=list_pending。" +
    "check/scan/overview/calendar/agenda 是查詢語氣或泛稱，不是事件標題。",
  availability: "本層固定 find_free。抽出日期、時段與 duration；使用者拿空檔做什麼不是 filter_keyword。",
  people: "問團隊名單=list_members；問本人和某人的共同事件=events_with_person。不可把兩者同時選。",
  analytics: "問單一期間數量=count_events；兩期間比較=compare_load；最忙日/分布/習慣=stats；明確要求列出每筆且附總數=list_events；問某團隊有幾個人/幾位成員=list_members（數的是人不是行程）。",
  mutation: "新增=schedule；移動既有事件=reschedule；刪除=cancel；接受/婉拒邀請=respond_rsvp。",
  out_of_scope: "固定 out_of_scope；不要因原句提到日期或會議就改成日曆查詢。",
};


/** 查詢意圖 → QuerySpec.intent 對映（schedule / list_members 走各自分支，不需要 spec）。 */
const SPEC_INTENT: Record<RouteIntent, QuerySpec["intent"]> = {
  list_events: "list",
  count_events: "count",
  find_free: "find_free",
  list_pending: "pending",
  list_members: "list", // 未用（list_members 走成員分支）
  schedule: "list", // 未用（schedule 走委員會分支）
  next_event: "list", // 下一個/即將到來（跨窗）
  event_detail: "list", // 事件細節
  search_events: "list", // 關鍵字全域搜尋
  events_with_person: "list", // 依人查
  compare_load: "count", // 比較負載
  stats: "count", // 統計
  reschedule: "list", // 改期（走破壞性動作分支）
  cancel: "list", // 取消（走破壞性動作分支）
  respond_rsvp: "pending", // 回覆邀請（走 RSVP 分支）
  out_of_scope: "list", // 非日曆（走擋掉分支，不需 spec）
};



/**
 * 每個 family 只暴露它真正會用到的 slots。
 *
 * 這同時是延遲與品質優化：實測同一台 GPU 上，22 欄位 structured output 需 279 個 output
 * token（約 8.0s），6 欄位只需 68 個（約 2.0s）——延遲幾乎與輸出欄位數線性相關。少欄位
 * 也讓 14B 不必為無關槽位（如查詢時的 rsvp_decision）編值，減少互相污染。
 */
const FAMILY_SLOTS: Record<RouteFamily, readonly (keyof RouteRaw)[]> = {
  agenda: ["anchor", "weekday_from", "weekday_to", "daypart", "filter_keyword", "filter_kind", "requested_detail", "order", "search_range"],
  availability: ["anchor", "weekday_from", "weekday_to", "daypart", "duration_minutes"],
  people: ["person_name", "group_name", "anchor", "search_range", "count_target"],
  analytics: ["anchor", "weekday_from", "weekday_to", "daypart", "filter_keyword", "filter_kind", "requested_detail", "count_target"],
  mutation: ["anchor", "weekday_from", "weekday_to", "daypart", "filter_keyword", "filter_kind", "to_anchor", "to_weekday", "to_daypart", "edit_scope", "rsvp_decision"],
  out_of_scope: [],
};

/**
 * RouteRaw 的安全預設：未暴露給該 family 的欄位一律走後端預設，不讓模型亂填。
 * 注意 filter_kind 刻意不給預設：它是「模型對 filter 的判斷」，沒判斷過就必須是 unknown，
 * 否則會把合法關鍵字當成被否決（實測會讓 search_events 反過來要求使用者再給關鍵字）。
 */
const RAW_DEFAULTS: Omit<RouteRaw, "intent" | "filter_kind"> & { filter_kind?: RouteRaw["filter_kind"] } = {
  anchor: "none",
  weekday_from: null,
  weekday_to: null,
  daypart: "any",
  filter_keyword: null,
  requested_detail: "none",
  count_target: "none",
  group_name: null,
  order: "all",
  person_name: null,
  duration_minutes: null,
  search_range: "future",
  to_anchor: null,
  to_weekday: null,
  to_daypart: "any",
  edit_scope: "this",
  rsvp_decision: null,
  confidence: "medium",
  ambiguity: "none",
  secondary_intent: null,
  evidence_spans: [],
};

/** 對外（給模型）用自述式標籤，對內沿用 QuerySpec 的 order 值。 */
const ORDER_LABEL_TO_SPEC: Record<string, QuerySpec["order"]> = {
  all: "none",
  earliest_one: "first",
  latest_one: "last",
  next_one: "next",
  // 舊 fixture / 快取相容
  none: "none",
  first: "first",
  last: "last",
  next: "next",
};

function combinedSpecialistSchema(family: RouteFamily): z.ZodType<Partial<RouteRaw>> {
  const tuple = FAMILY_INTENTS[family] as [RouteIntent, ...RouteIntent[]];
  const shape: Record<string, z.ZodTypeAny> = {
    intent: z.enum(tuple),
    confidence: z.enum(["high", "medium", "low"]),
    ambiguity: z.enum(["none", "missing_time", "missing_target", "unresolved_reference", "unclear"]),
  };
  const base = RouteSchema.shape as Record<string, z.ZodTypeAny>;
  for (const slot of FAMILY_SLOTS[family]) shape[slot as string] = base[slot as string];
  return z.object(shape) as unknown as z.ZodType<Partial<RouteRaw>>;
}

/** 只保留該 family 暴露的欄位，其餘補預設，交給既有 normalize/reconcile 處理。 */
function specialistRawToRouteRaw(family: RouteFamily, partial: Partial<RouteRaw>): RouteRaw {
  const raw = { ...RAW_DEFAULTS, intent: normalizeIntent(partial.intent) } as RouteRaw;
  for (const slot of [...FAMILY_SLOTS[family], "confidence", "ambiguity"] as (keyof RouteRaw)[]) {
    const value = partial[slot];
    if (value !== undefined) (raw as Record<string, unknown>)[slot as string] = value;
  }
  return raw;
}

const COMBINED_SPECIALIST_SYSTEM =
  "你是單一能力家族的日曆 specialist。只從允許的 functions 選一個，並在同一份結構化輸出抽 slots。" +
  "先理解整句目的，再抽參數；不要因某個單字改變任務。";

const SLOT_SYSTEM =
  "你是日曆 Slot Extractor。function 已由上一個 specialist 固定，你只抽參數，不可改 function。" +
  "時間 anchor：今天=today、明天=tomorrow、後天=day_after_tomorrow、這週=this_week、下週=next_week、上週=last_week、本月=this_month、下月=next_month、沒有=none。" +
  "weekday 週一=0 到週日=6；daypart 為 morning/afternoon/evening/any；跨全天或多時段=any。" +
  "filter_keyword 只可放使用者點名的事件名稱或主題；check/calendar/agenda、用途、語氣和日曆泛稱不是事件主題，filter_kind=none。" +
  "requested_detail：問某一場的地點=location、何時開始結束=start_end、持續多久=duration、誰參加=attendees；其他=none。" +
  "count_target：問數量時務必指出數的對象——數行程=events、數人/成員=people；不是數量問題=none。" +
  "group_name 只放團隊名稱，person_name 只放人名；duration_minutes 換算分鐘；order 要完整清單=all、只要最早一筆=earliest_one、只要最晚一筆=latest_one、只要下一筆=next_one。" +
  "沒有的 nullable 欄位填 null；confidence/ambiguity/evidence_spans 仍需填，evidence 必須逐字來自原文。";

const MutationFamilyVerificationSchema = z.object({
  family: z.enum(["mutation", "availability", "agenda"]),
  evidence_spans: z.array(z.string().min(1).max(80)).min(1).max(3),
});
const MUTATION_VERIFY_SYSTEM =
  "你是 PreToolUse verifier。判斷使用者是否真的要寫入日曆：" +
  "新增/改期/取消/回覆邀請=mutation；只是想找或保留一段可工作但沒有會議的時間=availability；只查看既有行程=agenda。" +
  "只輸出 family 與逐字原文 evidence，不可因『留時間做事』就假設要建立事件。";

const FilterVerifierSchema = z.object({
  is_event_subject: z.boolean(),
  evidence_spans: z.array(z.string().min(1).max(80)).min(1).max(3),
});
const FILTER_VERIFY_SYSTEM =
  "你是 slot verifier。判斷候選 filter 是否真的是使用者點名的事件名稱/主題。" +
  "command 語氣、calendar/agenda 等日曆泛稱、查詢用途、日期時段都不是事件主題。" +
  "只輸出 boolean 與逐字原文 evidence。";

/** 第二層：固定 family 後選 function 並抽槽位。抽成函式以支援推測式並行執行。 */
function callSpecialist(family: RouteFamily, text: string, model: ChatModel) {
  const allowed = FAMILY_INTENTS[family].join("、");
  return model.invokeStructured(combinedSpecialistSchema(family), [
    {
      role: "system",
      content: `${COMBINED_SPECIALIST_SYSTEM} family=${family}；允許 functions=${allowed}。${FAMILY_DETAIL_SYSTEM[family]} ${SLOT_SYSTEM}`,
    },
    { role: "human", content: text },
  ]);
}

/**
 * 依子句切分結果請 Planner 產出 1–3 個可獨立執行的請求。
 * 回傳長度 < 2 代表「其實是單一需求」，由呼叫端走單一路徑。
 */
async function planSubtasks(text: string, model: ChatModel): Promise<PlannedSubtask[]> {
  try {
    let decomposition = await model.invokeStructured(DecompositionSchema, [
      { role: "system", content: DECOMPOSITION_SYSTEM },
      { role: "human", content: text },
    ]);
    let subtasks = validPlannedTasks(text, decomposition);
    // 切分器已確認有多個子句時給一次明確 feedback 的重試（硬上限 1 次，不自由遞迴）。
    if (subtasks.length < 2 && clauseSegments(text).length >= 2) {
      decomposition = await model.invokeStructured(DecompositionSchema, [
        {
          role: "system",
          content: `${DECOMPOSITION_SYSTEM} 切分器已確認原句包含至少兩個獨立子句；上一版拆分不足。請重新產生 2–3 個 tasks。`,
        },
        { role: "human", content: text },
      ]);
      subtasks = validPlannedTasks(text, decomposition);
    }
    return subtasks;
  } catch {
    // Planner 格式錯誤 → 當成單一需求（仍有寫入/隱私 preflight 保護）。
    return [];
  }
}

/**
 * Agent-first 路由：一次 LLM 呼叫決定 intent + 查詢參數。
 * LLM 不可用 / 回傳壞掉 → 兜底 rulesFallback（不卡死），並標記 via。
 */
export async function routeMessage(
  text: string,
  model: ChatModel,
  groups: string[] = [],
  options: RouteOptions = {},
): Promise<RouteResult> {
  // 優化 D：先查 route 快取（只快取真的打過 14B 的結果；route 與誰問/DB 狀態無關，安全）。
  // backstop 會參考 workspace 的群組名稱，故 cache key 帶群組指紋，避免跨 workspace 誤命中。
  const baseScope = cacheScope(groups);
  const scope = options.forcedFamily ? `${baseScope}|family:${options.forcedFamily}` : baseScope;
  const cached = getCachedRoute(text, scope);
  if (cached) return cached;

  // Cascade tier-0（ICLR 2025 deferral rule）：容易輸入完全不叫模型。
  // 實測每次結構化輸出約 2.4s，這條路徑把「明天有哪些行程」這類問法降到毫秒級。
  if (!options.forcedFamily) {
    const fastIntent = fastPathIntent(text, groups);
    if (fastIntent) {
      const fastSpec = reconcileSpec(normalizeSpec({ intent: SPEC_INTENT[fastIntent] }), text, groups);
      const fastResult: RouteResult = {
        intent: fastIntent,
        spec: fastSpec,
        via: "rules-cascade",
        semantic: normalizeSemanticAssessment(
          {
            confidence: "high", ambiguity: "clear", subject_scope: "own",
            requires_context: false, filter_kind: "none", evidence_spans: [],
          },
          text,
          fastIntent,
        ),
      };
      setCachedRoute(text, fastResult, scope);
      return fastResult;
    }
  }
  try {
    const compositional =
      !options.skipPlanning && !options.forcedFamily && !explicitlyDeclinesCalendarLookup(text) && looksCompositional(text);

    // 延遲優化：真正像多需求的句子直接先跑 Planner，省掉整句 family 那一次呼叫
    //（複合路徑本來就由各子句自己重新分類，整句 family 對結果沒有貢獻）。
    if (compositional) {
      const planned = await planSubtasks(text, model);
      if (planned.length >= 2) {
        const intent: RouteIntent = "list_events";
        const spec = normalizeSpec({ intent: SPEC_INTENT[intent] });
        const semantic = normalizeSemanticAssessment(
          { confidence: "high", ambiguity: "multiple_requests", subject_scope: "own", requires_context: false, filter_kind: "none", evidence_spans: [] },
          text,
          intent,
        );
        const result: RouteResult = { intent, spec, via: "agent", semantic, subtasks: planned };
        setCachedRoute(text, result, scope);
        return result;
      }
    }

    // 只給 system + 使用者這一句。**不要**插入沒有配對 assistant 回覆的範例問句：
    // 那不是合法 few-shot，而會把模型的 anchor 錨定到該範例
    //（實測插入「今天有什麼會」會讓 anchor 幾乎恆為 today，時間全靠後端覆核救回）。
    let familyRaw: FamilyRaw;
    let speculative: { family: RouteFamily; promise: Promise<unknown> } | null = null;
    if (options.forcedFamily) {
      familyRaw = {
        family: options.forcedFamily as unknown as FamilyRaw["family"],
        request_count: "one",
        confidence: "high",
        requires_context: false,
        subject_scope: options.forcedSubjectScope ?? "own",
        evidence_spans: [text],
      };
    } else {
      // Query-conditioned ICL：先用 embedding 找語意最相近的已判定範例再問 family。
      // 失敗時 formatFamilyExamples 回空字串，自動退回 zero-shot。
      const examples = await retrieveFamilyExamples(text);
      const demos = formatFamilyExamples(examples);

      // 推測式 cascade（ICLR 2025《Faster Cascades via Speculative Decoding》）：
      // 檢索到的最相近範例本身就是 family 先驗（已經算好，零額外成本）。
      // 在等 family 呼叫的同時，先用先驗 family 跑第二層；命中就省掉一整次序列化呼叫。
      // 實測本機 GPU 兩個並行請求 3.87s vs 循序 5.54s（聚合吞吐 1.46×），
      // 且 family 呼叫仍是最終裁決者 → **品質完全中立**，只影響延遲與 GPU 用量。
      // 只在前兩名檢索結果 family 一致時才推測：v17 實測單憑 top-1 命中率僅 55%
      //（138 勝 114 敗，淨 -220ms/題），代價是每次落空都白跑一次生成。
      const topFamily = examples[0]?.family;
      const secondFamily = examples[1]?.family;
      const priorFamily = topFamily && topFamily === secondFamily ? FAMILY_LABELS[String(topFamily)] : undefined;
      const canSpeculate = Boolean(priorFamily) && !options.skipPlanning && process.env.INAPP_SPECULATE !== "0";
      speculative = canSpeculate && priorFamily
        ? { family: priorFamily, promise: callSpecialist(priorFamily, text, model).catch(() => null) }
        : null;

      familyRaw = await model.invokeStructured(FamilySchema, [
        { role: "system", content: `${FAMILY_SYSTEM}${demos}` },
        { role: "human", content: text },
      ]);
    }
    let family: RouteFamily = FAMILY_LABELS[String(familyRaw.family)] ?? "agenda";
    const explicitlyNotCalendar = explicitlyDeclinesCalendarLookup(text);
    const notCalendarOperation = explicitlyNotCalendar;
    if (notCalendarOperation) family = "out_of_scope";
    const discourse = discourseSignals(text);
    // Planner 子任務（skipPlanning）本身就是單一需求，不可再被 compound 訊號攔下，
    // 否則會出現「第 N 個子需求需要補充：你一次提出了不只一個需求」這種自相矛盾的回覆。
    // 保險路徑：切分器沒看出多子句（例如沒有標點也沒有分配詞），但模型自己說是多需求。
    // 此時才多花一次 Planner 呼叫；成功拆解就走複合路徑，否則維持單一。
    if (!options.skipPlanning && !compositional && familyRaw.request_count === "multiple" && !notCalendarOperation) {
      const planned = await planSubtasks(text, model);
      if (planned.length >= 2) {
        const compoundIntent: RouteIntent = DEFAULT_FAMILY_INTENT[family];
        const compoundSpec = normalizeSpec({ intent: SPEC_INTENT[compoundIntent] });
        const compoundSemantic = normalizeSemanticAssessment(
          {
            confidence: familyRaw.confidence, ambiguity: "multiple_requests",
            subject_scope: familyRaw.subject_scope, requires_context: false,
            filter_kind: "none", evidence_spans: familyRaw.evidence_spans ?? [],
          },
          text,
          compoundIntent,
        );
        const compoundResult: RouteResult = {
          intent: compoundIntent, spec: compoundSpec, via: "agent",
          semantic: compoundSemantic, subtasks: planned,
        };
        setCachedRoute(text, compoundResult, scope);
        return compoundResult;
      }
    }

    // 走到這裡表示 Planner 沒有產出可執行的多步計畫（或句子本來就不像多需求）。
    // 唯讀需求照單一路徑回答；只有涉及修改日曆時才要求拆句，避免誤改。
    let multipleDetected = options.skipPlanning
      ? false
      : familyRaw.request_count === "multiple" && family === "mutation";

    // claw-code PreToolUse hook 的 family 版：mutation 是高風險家族，先用極小 verifier
    // 區分真正寫入、只是找空檔、或只是查詢，避免「留兩小時工作」誤走新增事件。
    if (family === "mutation" && !multipleDetected) {
      try {
        const verified = await model.invokeStructured(MutationFamilyVerificationSchema, [
          { role: "system", content: MUTATION_VERIFY_SYSTEM },
          { role: "human", content: text },
        ]);
        if (verified.evidence_spans.every((span) => text.includes(span.trim()))) family = verified.family;
      } catch {
        // verifier 不可用時保留第一層結果，後續仍有 readOnly/confirmation 防線。
      }
    }

    // 推測命中就直接用，否則為正確 family 重跑一次（family 呼叫永遠是最終裁決者）。
    const speculated = speculative && speculative.family === family ? await speculative.promise : null;
    const specialistRaw = (speculated ?? await callSpecialist(family, text, model)) as Awaited<ReturnType<typeof callSpecialist>>;
    const raw = specialistRawToRouteRaw(family, specialistRaw);
    let intent = normalizeIntent(raw.intent);
    let via: RouteResult["via"] = "agent";
    const bs = notCalendarOperation ? null : intentBackstop(text, intent, groups);
    if (bs && bs !== intent) {
      intent = bs;
      via = "agent+backstop";
    }
    if (
      ["agenda", "analytics"].includes(family) &&
      raw.requested_detail &&
      raw.requested_detail !== "none"
    ) {
      intent = "event_detail";
    }
    // 數量問題的關鍵不是選哪個工具，而是「數的對象」。讓模型直接回答對象後由後端對映，
    // 比要求它在 5 個工具間分辨「幾個人」與「幾個會」可靠得多（量詞相同，語意不同）。
    // 統計是「跨期間的模式」；若錨點是單一天，使用者其實是在問那天的量 → count。
    if (intent === "stats" && ["today", "tomorrow", "day_after_tomorrow"].includes(raw.anchor)) {
      intent = "count_events";
    }
    // next_event 問的是「viewer 自己的下一筆」。若句子點名了團隊或某個人，
    // 使用者其實要的是該範圍的行程清單（實測「工程團隊那邊接下來有什麼安排」
    // 會回 viewer 自己的站立會）。
    if (intent === "next_event") {
      // 句子提到的團隊名稱可能沒被模型填進 group_name，故直接用 workspace 既有名稱比對
      //（去掉「團隊/小隊/小組」等泛型後綴後的核心詞也算）。
      const coreOf = (g: string) => g.replace(/團隊|小隊|小組|群組|團|隊|組|群|\s+/g, "").toLowerCase();
      const mentionsGroup = groups.some((g) => {
        if (text.includes(g)) return true;
        const core = coreOf(g);
        return core.length >= 2 && text.toLowerCase().includes(core);
      });
      if (raw.group_name || mentionsGroup) intent = "list_events";
      else if (raw.person_name) intent = "events_with_person";
    }
    if (raw.count_target === "people") intent = "list_members";
    else if (raw.count_target === "events" && intent === "list_members") intent = "count_events";
    raw.intent = intent;
    if (raw.filter_keyword && raw.filter_kind === "event_subject") {
      try {
        const verifiedFilter = await model.invokeStructured(FilterVerifierSchema, [
          {
            role: "system",
            content: `${FILTER_VERIFY_SYSTEM} 候選 filter=${JSON.stringify(raw.filter_keyword)}；固定 function=${intent}。`,
          },
          { role: "human", content: text },
        ]);
        if (
          verifiedFilter.evidence_spans.every((span) => text.includes(span.trim())) &&
          !verifiedFilter.is_event_subject
        ) {
          raw.filter_keyword = null;
          raw.filter_kind = "none";
        }
      } catch {
        // verifier 失敗時仍由既有 normalize/reconcile noise gate 處理。
      }
    }
    // next_event 是「從現在起全域下一筆」。若模型同時抽到日期/星期範圍，使用者其實問的是
    // 該範圍最早一筆；改走 list_events + order=first，避免忽略「下週一」而回今天下一場。
    if (intent === "next_event" && (raw.anchor !== "none" || raw.weekday_from !== null)) {
      intent = "list_events";
      raw.order = "earliest_one" as RouteRaw["order"];
    }
    // count+list 並非兩件獨立工作：列表模板本身含總數，選 list 可一次完整回答，
    // 避免只回數字而漏掉使用者明確要求的名稱。
    intent = canonicalizePrimaryIntent(intent, raw.secondary_intent);
    let spec = normalizeSpec({
      intent: SPEC_INTENT[intent],
      anchor: raw.anchor,
      weekday_from: raw.weekday_from,
      weekday_to: raw.weekday_to,
      daypart: raw.daypart,
      filter_keyword: raw.filter_keyword,
      group_name: raw.group_name,
      order: ORDER_LABEL_TO_SPEC[String(raw.order)] ?? "none",
      person_name: raw.person_name,
      duration_minutes: raw.duration_minutes,
      search_range: raw.search_range,
      to_anchor: raw.to_anchor,
      to_weekday: raw.to_weekday,
      to_daypart: raw.to_daypart,
      edit_scope: raw.edit_scope,
      rsvp_decision: raw.rsvp_decision,
    });
    // 必須用「清洗後的 spec」判斷是否真有目標：若用模型原始輸出，像「之前那筆行程」被抽出的
    // 泛詞 filter（行程/那場）會被誤當成明確目標，反而把無上下文的回指問題當成可直接回答。
    const cleanedSpec = normalizeSpec({ ...spec, filter_keyword: spec.filter_keyword });
    let noiseFreeSpec = reconcileSpec(cleanedSpec, text, groups);

    // 人名確定性覆核：句中出現本 workspace 既有成員全名時補上 person_name。
    // 只在「搜尋類但沒有主題關鍵字」時改寫意圖——避免把「一對一：王大文 是幾點」
    // 這種點名單一行程的細節問題誤導成查共同行程。
    const knownPerson = (options.people ?? []).find((name) => name && text.includes(name)) ?? null;
    if (knownPerson && !spec.person_name) {
      // 注意要寫進 spec（最終回傳的那一份），noiseFreeSpec 只用於判斷「是否有明確目標」。
      spec = { ...spec, person_name: knownPerson };
      noiseFreeSpec = { ...noiseFreeSpec, person_name: knownPerson };
    }
    const hasExplicitTarget = Boolean(
      noiseFreeSpec.filter_keyword || noiseFreeSpec.person_name || noiseFreeSpec.group_name,
    );
    const selectedAmbiguity = raw.ambiguity;
    const effectiveAmbiguity = hasExplicitTarget && ["missing_target", "unresolved_reference"].includes(selectedAmbiguity)
      ? "none"
      : selectedAmbiguity;
    const semantic = normalizeSemanticAssessment(
      {
        confidence: familyRaw.confidence === "low" ? "low" : raw.confidence,
        ambiguity: multipleDetected ? "multiple_requests" : effectiveAmbiguity,
        secondary_intent: null,
        secondary_family: null,
        subject_scope: familyRaw.subject_scope,
        deictic_reference: discourse.unresolvedReference,
        // 指示詞（那個/這場）已在 slot 清洗階段被當成雜訊移除，因此 cleaned spec 若仍留有
        // 目標，代表使用者其實點名了主題（「那個看牙的要多久」→ 看牙），可直接回答；
        // 只有清洗後真的沒有任何目標，才是無上下文回指。
        requires_context: discourse.discardsPriorContext || hasExplicitTarget
          ? false
          : discourse.unresolvedReference || familyRaw.requires_context,
        filter_kind: raw.filter_kind,
        evidence_spans: [
          ...(familyRaw.evidence_spans ?? []),
          ...(raw.evidence_spans ?? []),
        ],
      },
      text,
      intent,
    );
    spec = applySemanticSpecContract(spec, semantic);

    // 人名 → 共同行程的意圖覆核必須放在語意契約**之後**：
    // 實測 14B 會把人名塞進 filter_keyword（filter_kind=none），契約清掉它之前
    // 看起來像「已有主題」，覆核就不會觸發，結果回「你想找關於什麼的行程呢」。
    // 只在沒有真正主題關鍵字時改寫，避免動到「一對一：王大文 是幾點」這種點名單一行程的問題。
    if (knownPerson && !spec.filter_keyword && (intent === "search_events" || intent === "list_events")) {
      const asksWhichMeetings = /哪些|哪幾|什麼時候|何時|共同|一起|碰面|碰到|重疊|有沒有.*(會|行程)/.test(text);
      if (asksWhichMeetings) intent = "events_with_person";
    }

    const result: RouteResult = { intent, spec, via, semantic };
    setCachedRoute(text, result, scope); // 優化 D：快取真的打過 14B 的結果（依群組指紋分槽）
    return result;
  } catch {
    return rulesFallback(text);
  }
}

/**
 * 高精度意圖 backstop：只在**不會誤傷**的極明確措辭上覆核 agent 的輸出。
 * 覆蓋範圍刻意很窄（寧可不修，也不誤改），且只對「查詢/待辦」類意圖動手，
 * 不碰 schedule / list_members（那些交給 agent，誤傷成本高）。回 null = 不覆核。
 */
export function intentBackstop(
  text: string,
  agentIntent: RouteIntent,
  groups: string[] = [],
): RouteIntent | null {
  const t = text.toLowerCase();
  // out_of_scope 安全網（單向 擋→放行）：只在原文含**日曆名詞**或**時間詞＋問行程動詞**時放行，
  // 避免「今天天氣」這種「時間詞＋非日曆名詞」誤觸發（「今天」單獨不足以判為日曆問題）。
  if (agentIntent === "out_of_scope") {
    const calNoun = /會議|開會|行程|排程|安排|預約|空檔|有空|待回覆|邀請|團隊|小隊|組員|成員|公務車|會議室|待辦|\b會\b|幾個會/.test(text);
    const timeWord = /星期|週[一二三四五六日]|禮拜|今天|明天|後天|這週|下週|下一個|接下來|等一下/.test(text);
    const scheduleVerb = /有什麼|有哪些|要幹嘛|要做什麼|忙|幾點|排/.test(text);
    // 只有日曆名詞不足以判定是在查日曆（例：會議室的投影機怎麼連線）；
    // 必須同時出現時間詞或問行程的動詞才覆核放行。
    if (calNoun && (timeWord || scheduleVerb)) return "list_events";
    if (timeWord && scheduleVerb) return "list_events";
    return null; // 確實非日曆 → 尊重 agent 的 out_of_scope
  }
  // schedule 是動作型，agent 判它就尊重它；backstop 不把「查詢」改成 schedule。
  if (agentIntent === "schedule") return null;

  // 忙碌程度比較：「比較忙／比較輕鬆／比較滿」是極明確的比較措辭，
  // 不是找空檔也不是列清單。實測第一層偶爾會把「下週會不會比較輕鬆」判成 free_time。
  if (agentIntent === "find_free" || agentIntent === "list_events" || agentIntent === "count_events") {
    if (/比較(?:忙|輕鬆|閒|空|滿|多|少)|比較不忙|哪[天邊個].*(?:比較)?(?:忙|滿|輕鬆)|忙一點|輕鬆一點|忙很多/.test(text)) {
      return "compare_load";
    }
  }

  // 「<某個行程>多久／多長」問的是單一行程的時長，不是某段期間的清單。
  // 實測「週回顧多長？」因為標題含「週」被解成 this_week 並列出整週 16 筆。
  // 只有在能從封閉語法結構抽出主題時才覆核，避免把「明天多久」這種無主題句誤導。
  // 點名某個行程問時長，永遠是該行程的細節，不可能是清單、數量或統計。
  if (["list_events", "count_events", "stats", "compare_load"].includes(agentIntent)) {
    const asksDuration = /多久|多長|多长|幾分鐘|几分钟|幾小時|几小时/.test(text);
    if (asksDuration && subjectKeywordFromText(text)) return "event_detail";
  }
  // events_with_person 守門：「跟某團隊/某組的會」是**群組過濾**，不是「我跟某個人」。
  // 14B 常把群組名當人名（如「這禮拜有沒有跟產品團隊的會」→ events_with_person）。
  if (agentIntent === "events_with_person") {
    const namedGroupHit = groups.some((g) => g.trim().length >= 2 && text.includes(g.trim()));
    if (namedGroupHit || /團隊|小隊|這組|那組|部門|全體|大家/.test(text)) return "list_events";
    return null;
  }
  // reschedule 守門：真正的改期必須有「位移/變更訊號」（改/挪/移/延/提前/換/調整…）。
  // 少了它，「幫我把週五的專案同步會排一下」其實是要**新排**一場（schedule）——
  //「排一下」只是安排，沒有任何變更既有時間的語意；誤走改期會去比對既有事件、
  // 甚至對錯的事件開出確認預覽。反之「把明天的會議改一下」有「改」即屬改期。
  if (agentIntent === "reschedule") {
    const moveSignal = /改|挪|移|延|提前|往後|往前|重新排|重排|換|順延|調整|排到/.test(text);
    if (!moveSignal) return "schedule";
    return null;
  }
  // 統計/模式：極明確（最忙星期幾、平均一天幾個、下午常在開會）——先於 count（含「幾個」）。
  if (/最忙.*(星期|週|禮拜)|(星期|週|禮拜).*最忙|平均.*(幾個|多少)|通常.*(開會|忙)|常.*開會|哪.{0,2}(天|日).*最忙/.test(text)) return "stats";
  // 比較負載：極明確（比上週/比上個月/變多了）——先於 count（含「忙嗎」）。
  if (/比上(週|周|個月|月)|跟上(週|周|個月|月).*比|比.*(上週|上個月|以前)|變(多|少)了?(嗎)?|有沒有變(多|少)/.test(text)) return "compare_load";
  // 下一個/即將到來：極明確（接下來/等一下/待會 + 有啥/要幹嘛/是什麼）。
  // 但排除帶「數量詞或天數範圍」的（如「接下來三天有幾個會」是 count/list，不是 next_event）。
  const hasQuantOrSpan = /幾個|幾場|多少|\d+\s*天|這週|下週|這個月/.test(text);
  // 「最後一個/最晚」問的是區間內最後一筆，不是「下一個」——必須先擋掉，
  // 否則會答成最早的那一筆（實測「明天最後一個行程是什麼」被答成 09:30 站立會）。
  if (/最後一(個|場|件)|最晚|最後那(個|場)|最末/.test(text)) return "list_events";
  if (!hasQuantOrSpan && /接下來.{0,4}(有啥|有什麼|是什麼|要幹|要做|做什麼)|等一?下.{0,4}(有|是|要幹|要做)|待會.{0,4}(有|是|要幹|要做)|下一(個|場|件).{0,4}(是|做|幹|什麼)|再來.{0,3}(是|做|幹|什麼)/.test(text)) return "next_event";
  // 待回覆 / RSVP：極明確
  if (/待.{0,2}回覆|待回|待處理|還沒回|沒回覆|回覆的邀請|回覆邀請|誰約我|邀請我.{0,3}回|在等我回|rsvp/.test(t)) return "list_pending";
  // 找空檔：極明確
  if (/有沒有空|有空嗎|空檔|空閒|哪個?時段.*空|空的時段|available|free\b/.test(t)) return "find_free";
  // 數量 / 忙碌 / 空閒程度：極明確（含「排滿了沒」「很閒/很忙」概覽）。
  if (/幾個|幾場|多少個?會|忙不忙|忙嗎|滿不滿|排滿了?沒|排滿了?嗎|很閒|很忙|閒不閒|多忙|how many/.test(text)) return "count_events";
  // 團隊/群組成員名單：極明確——「成員/組員/隊員」，或「這/那 + 隊/組/團隊 + 有誰/都有誰/誰在跑」，
  // 或原文直接點名 workspace 真實存在的群組（如「產品團隊現在誰是負責人」）。
  // 刻意收斂：需同時出現「群體指涉」與「問人」語意，避免誤吞「明天有誰的會」。
  const namedGroup = groups.some((g) => g.trim().length >= 2 && text.includes(g.trim()));
  const groupWord =
    namedGroup || /組員|隊員|成員|團隊裡?|小隊|這組|那組|這隊|那隊|這團|那團|這群|那群/.test(text);
  const whoWord = /有誰|都有誰|是誰|誰是|哪些人|由誰|誰在|誰負責|負責人|主管|leader/i.test(text);
  // 「問人」但同時在問會議本身（如「明天的會有誰要來」）→ 交給 event_detail，不搶成員名單。
  const asksAboutEvent = /會議|開會|那個會|這個會|行程|\b會\b.{0,3}(有誰|誰要來)/.test(text);
  if (groupWord && whoWord && !asksAboutEvent) return "list_members";
  return null;
}

/** 群組指紋：讓 route 快取依 workspace 群組分槽（群組會影響 backstop 判斷）。 */
function cacheScope(groups: string[]): string {
  if (!groups.length) return "";
  return groups
    .map((g) => g.trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

function normalizeIntent(v: unknown): RouteIntent {
  const allowed: RouteIntent[] = [
    "list_events",
    "count_events",
    "find_free",
    "list_pending",
    "list_members",
    "schedule",
    "next_event",
    "event_detail",
    "search_events",
    "events_with_person",
    "compare_load",
    "stats",
    "reschedule",
    "cancel",
    "respond_rsvp",
    "out_of_scope",
  ];
  return (allowed as string[]).includes(v as string) ? (v as RouteIntent) : "list_events";
}

/**
 * 規則兜底（LLM 不可用時）：沿用既有 classifyByRules 判 intent，spec 給安全預設，
 * 後續由 service 端的規則時間窗解析（resolveTimeWindow）補齊時間。
 */
export function rulesFallback(text: string): RouteResult {
  const intent = classifyByRules(text) ?? "list_events";
  const spec = normalizeSpec({ intent: SPEC_INTENT[intent] });
  return { intent, spec, via: "rules-fallback" };
}
