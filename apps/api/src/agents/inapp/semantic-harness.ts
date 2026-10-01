import type { QuerySpec } from "./query-spec.js";
import type { Intent } from "./intent.js";
import { looksCompositional } from "./clause-split.js";

/**
 * LLM 路由的語意契約。
 *
 * LangChain/Zod 只能保證「JSON 長得對」，不能保證模型真的理解原句。這一層要求模型
 * 同時交付 confidence、ambiguity、secondary intent 與原文 evidence spans，再以純函式
 * 驗證。如此可處理各種口語，而不是替每一種說法新增 regex。
 */
export type SemanticConfidence = "high" | "medium" | "low";
export type SemanticAmbiguity =
  | "none"
  | "missing_time"
  | "missing_target"
  | "unresolved_reference"
  | "multiple_requests"
  | "unclear";

export type RouteFamily = "agenda" | "availability" | "people" | "analytics" | "mutation" | "out_of_scope";
export type SubjectScope = "own" | "shared_with_person" | "team" | "other_person_private" | "none";

export interface SemanticAssessment {
  confidence: SemanticConfidence;
  ambiguity: SemanticAmbiguity;
  secondary_intent: Intent | null;
  secondary_family: RouteFamily | null;
  subject_scope: SubjectScope;
  /** 原始回指訊號（未被目標判定壓過）：用來禁止在回指句上猜任意事件。 */
  deictic_reference: boolean;
  /** filter_keyword 的語意角色；unknown 僅供舊 fixture/快取向後相容。 */
  filter_kind: "event_subject" | "none" | "unknown";
  /** 經伺服器驗證、確實逐字出現在原文中的最短證據片段。 */
  evidence_spans: string[];
  /** 模型曾宣稱證據，但其中含非原文片段；供觀測與降信心使用。 */
  invalid_evidence: boolean;
}

const INTENTS = new Set<Intent>([
  "list_events", "count_events", "find_free", "list_pending", "list_members", "schedule",
  "next_event", "event_detail", "search_events", "events_with_person", "compare_load", "stats",
  "reschedule", "cancel", "respond_rsvp", "out_of_scope",
]);
const CONFIDENCE = new Set<SemanticConfidence>(["high", "medium", "low"]);
const AMBIGUITY = new Set<SemanticAmbiguity>([
  "none", "missing_time", "missing_target", "unresolved_reference", "multiple_requests", "unclear",
]);

export interface RawSemanticAssessment {
  confidence?: unknown;
  ambiguity?: unknown;
  secondary_intent?: unknown;
  secondary_family?: unknown;
  subject_scope?: unknown;
  requires_context?: unknown;
  deictic_reference?: unknown;
  filter_kind?: unknown;
  evidence_spans?: unknown;
}

/** 將模型的語意自評正規化，且只保留原文中真的存在的 evidence。 */
export function normalizeSemanticAssessment(
  raw: RawSemanticAssessment,
  originalText: string,
  primaryIntent: Intent,
): SemanticAssessment {
  let confidence: SemanticConfidence = CONFIDENCE.has(raw.confidence as SemanticConfidence)
    ? (raw.confidence as SemanticConfidence)
    : "medium";
  const ambiguity: SemanticAmbiguity = AMBIGUITY.has(raw.ambiguity as SemanticAmbiguity)
    ? (raw.ambiguity as SemanticAmbiguity)
    : "none";
  const candidateSecondary = INTENTS.has(raw.secondary_intent as Intent) && raw.secondary_intent !== primaryIntent
    ? (raw.secondary_intent as Intent)
    : null;
  // specialized query + list_events 通常是同一件工作，不是兩件：例如「下一場是什麼」同時
  // 被標成 next_event/list_events，或「最忙哪天」被標成 stats/list_events。這些若追問會很煩。
  const listSubsumedBy = new Set<Intent>([
    "count_events", "find_free", "next_event", "event_detail", "search_events",
    "events_with_person", "compare_load", "stats",
  ]);
  const redundantPairs = new Set([
    "next_event:event_detail", "list_events:event_detail", "stats:count_events",
    "list_members:list_events", "list_pending:list_events",
  ]);
  const secondary =
    (candidateSecondary === "list_events" && listSubsumedBy.has(primaryIntent)) ||
    (candidateSecondary === "out_of_scope" && primaryIntent !== "out_of_scope") ||
    (primaryIntent === "list_events" && candidateSecondary === "count_events") ||
    redundantPairs.has(`${primaryIntent}:${candidateSecondary}`)
      ? null
      : candidateSecondary;
  const filterKind = raw.filter_kind === "event_subject" || raw.filter_kind === "none"
    ? raw.filter_kind
    : "unknown";
  const families = new Set<RouteFamily>(["agenda", "availability", "people", "analytics", "mutation", "out_of_scope"]);
  const secondaryFamily = families.has(raw.secondary_family as RouteFamily)
    ? (raw.secondary_family as RouteFamily)
    : null;
  const scopes = new Set<SubjectScope>(["own", "shared_with_person", "team", "other_person_private", "none"]);
  const subjectScope = scopes.has(raw.subject_scope as SubjectScope)
    ? (raw.subject_scope as SubjectScope)
    : "none";

  const claimed = Array.isArray(raw.evidence_spans)
    ? raw.evidence_spans.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean).slice(0, 8)
    : [];
  const evidence = Array.from(new Set(claimed.filter((span) => originalText.includes(span))));
  const invalidEvidence = claimed.some((span) => !originalText.includes(span));
  // 模型若引用了原文不存在的「證據」，其高信心不可信；但 legacy/stub 沒交 evidence
  // 不視為錯誤，保持向後相容。
  if (invalidEvidence && confidence === "high") confidence = "medium";

  const normalizedAmbiguity: SemanticAmbiguity = raw.requires_context === true
    ? "unresolved_reference"
    : secondaryFamily
      ? "multiple_requests"
      : secondary
        ? "multiple_requests"
        : candidateSecondary && ambiguity === "multiple_requests"
          ? "none"
          : ambiguity;
  return {
    confidence,
    ambiguity: normalizedAmbiguity,
    secondary_intent: secondary,
    secondary_family: secondaryFamily,
    subject_scope: subjectScope,
    deictic_reference: raw.deictic_reference === true,
    filter_kind: filterKind,
    evidence_spans: evidence,
    invalid_evidence: invalidEvidence,
  };
}

/**
 * 以模型已理解的「槽位語意角色」約束 QuerySpec，而不是維護 command-word 黑名單。
 * - find_free 的 filter 從未參與空檔計算，保留只會產生「簡報『簡報』空檔」之類假精確標籤。
 * - 新 semantic schema 明確說 filter 不是事件主題時清掉；legacy unknown 則維持舊行為。
 */
export function applySemanticSpecContract(spec: QuerySpec, semantic: SemanticAssessment): QuerySpec {
  if (spec.intent === "find_free" || semantic.filter_kind === "none") {
    return { ...spec, filter_keyword: null };
  }
  return spec;
}

/** count + list 的答案可由 list 一次完整涵蓋；選資訊較多的 primary，避免漏掉名稱清單。 */
export function canonicalizePrimaryIntent(primary: Intent, secondary: unknown): Intent {
  return primary === "count_events" && secondary === "list_events" ? "list_events" : primary;
}

const INTENT_LABELS: Record<Intent, string> = {
  list_events: "查看行程", count_events: "計算行程數量", find_free: "找空檔",
  list_pending: "查看待回覆邀請", list_members: "查看團隊成員", schedule: "安排新行程",
  next_event: "查看下一個行程", event_detail: "查看行程細節", search_events: "搜尋行程",
  events_with_person: "查詢與某人的共同行程", compare_load: "比較忙碌程度", stats: "查看行程統計",
  reschedule: "更改行程時間", cancel: "取消行程", respond_rsvp: "回覆邀請",
  out_of_scope: "處理非日曆問題",
};

/**
 * 跨欄位語意驗證。回傳 null 代表可安全執行；回傳字串則應先向使用者澄清。
 * 只處理「猜錯會造成靜默錯答或副作用」的情況，不因一般口語或中等信心打擾使用者。
 */
export function clarificationForSemanticRoute(
  intent: Intent,
  spec: QuerySpec,
  semantic?: SemanticAssessment,
): string | null {
  if (!semantic) return null; // 舊快取/測試 stub

  if (semantic.subject_scope === "other_person_private") {
    return "我只能查看你自己的行程，以及你本人受邀的共同行程；不能顯示其他人的私人日曆內容。";
  }

  if (semantic.secondary_family) {
    const familyLabels: Record<RouteFamily, string> = {
      agenda: "查行程", availability: "找空檔", people: "查團隊或共同行程",
      analytics: "統計忙碌程度", mutation: "修改行程", out_of_scope: "非日曆事項",
    };
    return `我聽到兩類需求：「${familyLabels[semantic.secondary_family]}」以及另一個日曆需求。為了避免漏做，請分成兩句或先指定其中一件。`;
  }

  if (semantic.secondary_intent) {
    return `我聽到兩個需求：「${INTENT_LABELS[intent]}」和「${INTENT_LABELS[semantic.secondary_intent]}」。為了避免漏做或做錯，請先告訴我要先處理哪一個。`;
  }
  if (semantic.ambiguity === "multiple_requests") {
    return "我聽起來你一次提出了不只一個日曆需求。為了避免漏做，請先告訴我要先處理哪一件。";
  }

  if (semantic.ambiguity === "unresolved_reference") {
    return "你提到的「那個／它／上一場」目前沒有足夠上下文。請補上行程名稱或日期，我就能接著處理。";
  }

  const targetRequired = new Set<Intent>([
    "events_with_person", "reschedule", "cancel", "respond_rsvp",
  ]);
  const hasTarget = Boolean(spec.filter_keyword || spec.person_name || spec.group_name || spec.anchor !== "none" || spec.weekday_from !== null);
  if (targetRequired.has(intent) && !hasTarget) {
    if (intent === "events_with_person") return "你想查和誰的共同行程呢？請告訴我對方的名字。";
    if (intent === "search_events") return "你想搜尋哪一個行程主題？請提供名稱或關鍵描述。";
    return "你指的是哪一個行程？請補上行程名稱或日期。";
  }

  if (semantic.confidence === "low" && semantic.ambiguity === "unclear") {
    return "我不太確定你的日曆需求。你可以換句話說，例如要「查行程」、「找空檔」或「安排會議」。";
  }

  return null;
}


/**
 * discourse-level backstop：只辨認句法關係，不判斷任何日曆 intent 或事件關鍵字。
 * LLM 若漏報明確的「另外/然後/接著」第二動作，仍避免只做半句；若句首是無上下文
 * 指涉，避免任選下一場。這和逐一維護業務詞彙黑名單不同。
 */
export function discourseSignals(text: string): { multiple: boolean; unresolvedReference: boolean; discardsPriorContext: boolean } {
  // 多需求不再用「整句連接詞清單」判斷：該做法在連接詞改變時很脆弱
  // （arXiv:2603.28929 實測整句法在 connector shift 僅 10.4 EM）。改由 clause-split
  // 產生候選、Planner 逐子句決定；這裡只保留 discourse 層真正需要的兩個訊號。
  const multiple = looksCompositional(text);
  const discardsPriorContext = /(?:作廢|略過|不重要|不用管|不要了|算了)/.test(text) && /(?:只|現在|最後)/.test(text);
  const unresolvedReference = !discardsPriorContext && (
    /^(?:請|幫我|麻煩)?\s*(?:它|那一?(?:筆|場|件|個)|這一?(?:筆|場|件|個))/.test(text.trim()) ||
    // 前指詞（剛才/之前/前面）＋指示詞，不論中間有沒有動詞：「剛才那場在哪」同樣無法定位。
    /(?:剛才|剛剛|之前|前面|上次)(?:[^，。]{0,6})?(?:那|這)(?:一?(?:筆|場|件|個|次))?/.test(text) ||
    /(?:剛才|剛剛|之前|前面|上次)(?:講|說|提|聊|問)(?:過|到|的)?/.test(text)
  );
  return { multiple, unresolvedReference, discardsPriorContext };
}

/** 使用者明確否定查詢/操作日曆時，尊重其 stated scope；不會誤傷「不用查天氣，只看日曆」。 */
export function explicitlyDeclinesCalendarLookup(text: string): boolean {
  // 「存取日曆」的動詞是封閉類：查/查看/查詢/讀取/存取/操作/修改/看/動。
  return /(?:不需要|不用|不必|沒有要|無需)\s*(?:(?:查(?:看|詢)?|讀取|存取|操作|修改|看|動)(?:\s*(?:或|、|和)\s*)?)+(?:我的|這個)?\s*(?:日曆|行事曆|calendar)|(?:不是|並非)\s*(?:一個)?\s*(?:日曆|行事曆).{0,4}(?:查詢|操作|需求)/i.test(text);
}
