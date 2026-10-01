import { z } from "zod";
import type { ChatModel } from "../llm.js";

/**
 * 結構化查詢抽取（14B harness）。
 *
 * 實測 qwen3:14b：核心語意（intent/anchor/weekday/daypart/order）抓得好，但有兩個
 * systematic 格式病——(1) nullable 欄位亂填 ":null"/":none"/"" 當字串；(2) 中文複合詞
 * 誤拆（「產品團隊」→ 產品+團隊）。因此 model 只負責語意，harness 負責：
 *   - normalizeSpec：把髒 null 值清成真 null、trim、丟非法 enum
 *   - reconcileGroup：抽出的 group_name/keyword 對「真實 group 清單」覆核，兜正誤拆
 * 日期一律由後端從 anchor/weekday/daypart 算（time-window / daypart-window），model 不算日期。
 */

export const QuerySpecSchema = z.object({
  intent: z.enum(["list", "count", "find_free", "pending"]),
  anchor: z.enum(["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "last_week", "this_month", "next_month", "none"]),
  weekday_from: z.number().int().min(0).max(6).nullable(),
  weekday_to: z.number().int().min(0).max(6).nullable(),
  daypart: z.enum(["morning", "afternoon", "evening", "any"]),
  filter_keyword: z.string().nullable(),
  group_name: z.string().nullable(),
  order: z.enum(["first", "last", "next", "none"]),
  /** B4 依人查：問句提到的人名（如「跟 Mia 的會」→ Mia）；無則 null。 */
  person_name: z.string().nullable().optional(),
  /** B5 指定時長的空檔（分鐘）；無則 null（預設 60）。 */
  duration_minutes: z.number().int().min(15).max(600).nullable().optional(),
  /** B3/B4 搜尋時間範圍：future（預設）/past/all。 */
  search_range: z.enum(["future", "past", "all"]).optional(),
  /**
   * 絕對日期範圍（本地時區的 yyyy-mm-dd，含起訖日）。
   * 只有外部 agent 的 plan 會設定：相對錨點（今天/明天/下週）表達不了「9/26 那天」，
   * 而外部 agent 通常已經從先前的查詢知道確切日期（實測 minimax-m2.1 明確反映了這個缺口）。
   * 本地 14B 永遠不會產生這個欄位，因此對站內路徑零影響。
   */
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** 第三波 reschedule：新時間的錨點（改到哪天）。 */
  to_anchor: z.enum(["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "none"]).nullable().optional(),
  /** reschedule：新時間的星期（改到週幾）。 */
  to_weekday: z.number().int().min(0).max(6).nullable().optional(),
  /** reschedule：新時間的時段。 */
  to_daypart: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
  /** reschedule/cancel 的重複事件範圍：this（僅這次）/this_and_future/all。 */
  edit_scope: z.enum(["this", "this_and_future", "all"]).optional(),
  /** respond_rsvp 的回覆決定。 */
  rsvp_decision: z.enum(["accept", "decline"]).nullable().optional(),
});
export type QuerySpec = z.infer<typeof QuerySpecSchema>;

const NULLISH = new Set([":null", ":none", "null", "none", "", "n/a", "無", "沒有"]);

/** 把 14B 常見的髒字串正規化成真 null；trim。 */
function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // 模型常忠實保留使用者標示主題用的引號（『產品』/「產品」），但引號不是標題內容。
  // 只剝最外層成對/單側引號與空白，不改動內文。
  const t = v.trim().replace(/^[「『“”‘’'\"]+|[」』“”‘’'\"]+$/g, "").trim();
  if (NULLISH_HAS(t)) return null;
  return t.length ? t : null;
}
function NULLISH_HAS(t: string): boolean {
  return NULLISH.has(t.toLowerCase());
}

/**
 * 正規化 raw spec：清髒 null、驗 enum（非法退預設）、數值範圍。
 * 任何無法對上 schema 的欄位安全降級，絕不讓壞值往下游流。
 */
export function normalizeSpec(raw: Partial<QuerySpec>): QuerySpec {
  const intent = (["list", "count", "find_free", "pending"] as const).includes(raw.intent as never)
    ? (raw.intent as QuerySpec["intent"])
    : "list";
  const anchor = (["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "last_week", "this_month", "next_month", "none"] as const).includes(
    raw.anchor as never,
  )
    ? (raw.anchor as QuerySpec["anchor"])
    : "none";
  const daypart = (["morning", "afternoon", "evening", "any"] as const).includes(raw.daypart as never)
    ? (raw.daypart as QuerySpec["daypart"])
    : "any";
  const order = (["first", "last", "next", "none"] as const).includes(raw.order as never)
    ? (raw.order as QuerySpec["order"])
    : "none";
  const wd = (n: unknown): number | null =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;

  // normalize 後再經同一份 Zod schema 驗證，避免 RouteSchema → 手動 mapping → QuerySpec
  // 之間的欄位漂移靜默流進查詢層。這是最後的型別/範圍閘門，不只依賴 TypeScript。
  return QuerySpecSchema.parse({
    intent,
    anchor,
    weekday_from: wd(raw.weekday_from),
    weekday_to: wd(raw.weekday_to),
    daypart,
    filter_keyword: cleanStr(raw.filter_keyword),
    group_name: cleanStr(raw.group_name),
    // 絕對日期只接受 yyyy-mm-dd；格式不符一律視為沒給（外部輸入同樣要過閘門）
    date_from: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date_from ?? "")) ? String(raw.date_from) : null,
    date_to: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date_to ?? "")) ? String(raw.date_to) : null,
    order,
    person_name: cleanStr(raw.person_name),
    duration_minutes:
      typeof raw.duration_minutes === "number" && raw.duration_minutes >= 15 && raw.duration_minutes <= 600
        ? Math.round(raw.duration_minutes)
        : null,
    search_range: (["future", "past", "all"] as const).includes(raw.search_range as never)
      ? (raw.search_range as QuerySpec["search_range"])
      : "future",
    to_anchor: (["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "none"] as const).includes(raw.to_anchor as never)
      ? (raw.to_anchor as QuerySpec["to_anchor"])
      : null,
    to_weekday: wd(raw.to_weekday),
    to_daypart: (["morning", "afternoon", "evening", "any"] as const).includes(raw.to_daypart as never)
      ? (raw.to_daypart as QuerySpec["to_daypart"])
      : "any",
    edit_scope: (["this", "this_and_future", "all"] as const).includes(raw.edit_scope as never)
      ? (raw.edit_scope as QuerySpec["edit_scope"])
      : "this",
    rsvp_decision: (["accept", "decline"] as const).includes(raw.rsvp_decision as never)
      ? (raw.rsvp_decision as QuerySpec["rsvp_decision"])
      : null,
  });
}

/**
 * 原文覆核（harness）：用「使用者原始問句」校正 14B 的雜訊輸出。
 * 1. 單日 anchor（today/tomorrow/day_after）優先於 weekday 範圍 —— 14B 常在指定「明天」時
 *    又亂填 weekday_from/to 全範圍，這裡清掉。
 * 2. daypart 只在原文真的出現時段詞時採用 —— 14B 常無中生有填 afternoon。
 * 3. group 覆核（reconcileGroup）：用真實 group 清單兜正中文誤拆。
 */

/**
 * 從自然語句解析排序意圖。最高級是封閉詞類（如時長數字一樣可確定性解析），
 * 由後端判斷比要求 14B 每次選對 enum 可靠，且不增加任何模型呼叫或延遲。
 */
export function orderFromText(text: string): QuerySpec["order"] | null {
  if (/最後|最晚|最末|壓軸|收工前|收尾前|下班前最/.test(text)) return "last";
  if (/最早一?[個場件筆]?|第一[個場件筆]|最先|一開始那/.test(text)) return "first";
  return null;
}

/**
 * 從自然語句解析明確時長。時間數值屬 deterministic slot，後端解析比要求 14B 算術可靠。
 * 支援 45 分鐘、1.5 小時、一個半小時、四十五分鐘、半天等常見寫法；未命中回 null。
 */
/**
 * 從封閉的**語法結構**推出「使用者點名的主題」，補 14B 常漏抽的 filter_keyword。
 * 刻意只認語法（量詞結構、話題標記），不列任何詞彙清單，因此對沒見過的名稱同樣有效：
 *
 *   1) 量詞計數結構：「有幾場<主題>」「<主題>有幾場」→ 主題
 *   2) 話題標記結構：「<主題>被用在…」「<主題>排在…」→ 主題
 *
 * 回傳候選字串，仍需交給 isNoiseKeyword 做既有的雜訊驗證（泛稱、時間詞、整句等）。
 */
export function subjectKeywordFromText(text: string): string | null {
  const NP = "[\\u4e00-\\u9fa5A-Za-z0-9]{2,12}";
  // 主題名詞片語不可吞進疑問詞與功能詞（否則「大會議室被用在哪幾場會」會抓成
  // 「大會議室被用在哪」）。用逐字負向預查表達這個封閉功能詞集合。
  const NP_STRICT = "(?:(?![哪那被用在嗎呢幾几多少共總一有的])[\\u4e00-\\u9fa5A-Za-z0-9]){2,12}";
  const patterns = [
    // 「有幾場<主題>」：主題在量詞之後
    new RegExp(`(?:有|共|總共|一共)?\\s*(?:幾|几|多少)\\s*(?:場|场|個|个|次|件|筆|笔|堂|節|节)\\s*(${NP})`),
    // 「<主題>被用在…」：話題標記結構（先於下一條，否則量詞規則會反向吃掉整段）
    new RegExp(`(${NP_STRICT})\\s*(?:被|給|给)?\\s*(?:用在|使用在|排在|安排在|舉辦在|舉行在|舉行於|辦在)`),
    // 「<主題>那場／這場」：指示詞同位語（「技術債清理討論那場是什麼時候」）
    new RegExp(`(${NP_STRICT})\\s*(?:那|這|该|該)\\s*(?:場|场|個|个|件|筆|笔|次|天|通)`),
    // 「<主題>開多久」：時長謂語（有動詞版先試，否則貪婪匹配會把動詞吃進主題）
    new RegExp(`(${NP_STRICT})\\s*(?:要|大約|大概|約)?\\s*(?:開|开|進行|进行|持續|持续|舉行|举行|排了|排)\\s*(?:多久|多長|多长|幾分鐘|几分钟|幾小時|几小时)`),
    // 「<主題>多長」：動詞省略版（標題可能本身含「排」等字，故不可用字元排除）
    new RegExp(`(${NP_STRICT})\\s*(?:多久|多長|多长|幾分鐘|几分钟|幾小時|几小时)`),
    // 「<主題>有幾場」：主題在量詞之前
    new RegExp(`(${NP_STRICT})\\s*(?:有|共|總共|一共)?\\s*(?:幾|几|多少)\\s*(?:場|场|個|个|次|件|筆|笔)`),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const cand = m?.[1]?.trim();
    if (!cand || cand.length < 2) continue;
    // 純時間／序數詞不是主題（「明天有幾場會」的「明天」）
    const residue = cand.replace(TIME_WORDS, "").replace(ORDINAL_WORDS, "").trim();
    if (!residue) continue;
    return cand;
  }
  return null;
}

export function durationMinutesFromText(text: string): number | null {
  const bounded = (n: number) => Number.isFinite(n) && n >= 15 && n <= 600 ? Math.round(n) : null;
  const arabicHour = text.match(/(\d+(?:\.\d+)?)\s*(?:個)?\s*(?:小時|小时|鐘頭|钟头|hours?|hrs?)/i);
  if (arabicHour) return bounded(Number(arabicHour[1]) * 60);
  const arabicMinute = text.match(/(\d+)\s*(?:分鐘|分钟|mins?|minutes?)/i);
  if (arabicMinute) return bounded(Number(arabicMinute[1]));

  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const chineseNumber = (raw: string): number | null => {
    if (raw === "十") return 10;
    if (raw.includes("十")) {
      const [a, b] = raw.split("十");
      return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0);
    }
    return raw.length === 1 ? (digits[raw] ?? null) : null;
  };
  const halfHour = text.match(/([一二兩两三四五六七八九])?\s*(?:個)?半\s*(?:小時|小时|鐘頭|钟头)/);
  if (halfHour) return bounded(((halfHour[1] ? digits[halfHour[1]] : 0) + 0.5) * 60);
  const chineseHour = text.match(/([一二兩两三四五六七八九十]{1,3})\s*(?:個)?\s*(?:小時|小时|鐘頭|钟头)/);
  if (chineseHour) {
    const n = chineseNumber(chineseHour[1]);
    if (n !== null) return bounded(n * 60);
  }
  const chineseMinute = text.match(/([一二兩两三四五六七八九十]{1,3})\s*(?:分鐘|分钟)/);
  if (chineseMinute) {
    const n = chineseNumber(chineseMinute[1]);
    if (n !== null) return bounded(n);
  }
  if (/半天/.test(text)) return 240;
  return null;
}
/**
 * 規則時間錨點（比 14B 準）：從原文抽明確時間詞 → { anchor, weekday_from, weekday_to }。
 * 命中回部分 spec 覆蓋；未命中回 null（沿用 14B）。
 * 單一星期（禮拜五/週三/星期一）直接算 weekday，這是 14B 最常判錯的地方。
 */
function ruleAnchor(text: string): Partial<QuerySpec> | null {
  const t = text.toLowerCase();
  const wdMap: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
  const nextWeek = /下(?:個)?(?:禮拜|週|星期)/.test(text);

  // 星期「範圍」（優先於單一星期）：週三到週五 / 禮拜一至週三 / 星期二~五。
  // 第二個星期詞可省略「禮拜/週/星期」（如「週三到五」）。
  const rangeRe =
    /(?:這|本|下)?(?:個)?(?:禮拜|週|星期)([一二三四五六日天])\s*(?:到|至|~|-|—|－)\s*(?:(?:禮拜|週|星期))?([一二三四五六日天])/;
  const rm = text.match(rangeRe);
  if (rm) {
    const from = wdMap[rm[1]];
    const to = wdMap[rm[2]];
    if (from !== undefined && to !== undefined) {
      return { anchor: nextWeek ? "next_week" : "this_week", weekday_from: from, weekday_to: to };
    }
  }

  // 單一星期（因 14B 常把「這禮拜五」誤判 anchor）
  const wm = text.match(/(?:這|本|下)?(?:個)?(?:禮拜|週|星期)([一二三四五六日天])/);
  if (wm) {
    const wd = wdMap[wm[1]];
    if (wd !== undefined) {
      // 下週的單一星期：用 anchor=next_week + weekday 定位；本週則 this_week + weekday
      return { anchor: nextWeek ? "next_week" : "this_week", weekday_from: wd, weekday_to: wd };
    }
  }
  if (/後天|day after tomorrow/.test(t)) return { anchor: "day_after_tomorrow", weekday_from: null, weekday_to: null };
  if (/明天|明日|聽日|听日|明早|明晚|tomorrow/.test(t)) return { anchor: "tomorrow", weekday_from: null, weekday_to: null };
  if (/今天|今日|today|今晚|今夜|今早|今朝/.test(t)) return { anchor: "today", weekday_from: null, weekday_to: null };
  if (/下週|下周|next week/.test(t)) return { anchor: "next_week", weekday_from: null, weekday_to: null };
  if (/這週|本週|这周|this week|這禮拜|這星期/.test(t)) return { anchor: "this_week", weekday_from: null, weekday_to: null };
  // 上週 / 下個月：沒有這兩條，問「上週有哪些會」會被降級成 this_week（問 A 答 B）。
  if (/上週|上周|上禮拜|上個星期|last week/.test(t)) return { anchor: "last_week", weekday_from: null, weekday_to: null };
  if (/下個月|下月|next month/.test(t)) return { anchor: "next_month", weekday_from: null, weekday_to: null };
  if (/這個月|本月|this month/.test(t)) return { anchor: "this_month", weekday_from: null, weekday_to: null };
  return null;
}

export function reconcileSpec(spec: QuerySpec, rawText: string, groupNames: string[]): QuerySpec {
  let s = { ...spec };

  // 0. 規則時間錨點覆核（規則比 14B 準）：原文若含明確時間詞，覆蓋 anchor。
  // 若規則只辨認到「這週/下週」這種較粗範圍（weekday=null），保留模型已抽出的
  // 具體 weekday；否則簡體「这周日」會被規則降級成整週，反而丟失較精確資訊。
  const anchored = ruleAnchor(rawText);
  if (anchored) {
    s = {
      ...s,
      ...anchored,
      weekday_from: anchored.weekday_from ?? s.weekday_from,
      weekday_to: anchored.weekday_to ?? s.weekday_to,
    };
  }

  // 1. 單日 anchor 優先：清掉 weekday 雜訊
  if (["today", "tomorrow", "day_after_tomorrow"].includes(s.anchor)) {
    s = { ...s, weekday_from: null, weekday_to: null };
  }

  // 2. daypart 原文覆核：問句沒出現時段詞 → 丟棄
  const hasMorning = /上午|早上|早晨|朝早|明早/.test(rawText);
  const hasAfternoon = /下午|午後|下晝|下昼/.test(rawText);
  const hasEvening = /晚上|傍晚|夜間|夜晚|今晚|明晚|晚間|入夜/.test(rawText);
  const wordFor: Record<string, boolean> = { morning: hasMorning, afternoon: hasAfternoon, evening: hasEvening };
  // (a) 原文沒出現該時段詞 → 丟棄 model 無中生有的 daypart
  if (s.daypart !== "any" && !wordFor[s.daypart]) {
    s = { ...s, daypart: "any" };
  }
  // (a2) 原文同時出現多個時段詞（「下午到晚上」「早上跟晚上」）→ 這是跨時段範圍，
  //      任何單一 daypart 都會漏掉另一段，必須用 any 讓整天窗成立。
  const daypartWordCount = [hasMorning, hasAfternoon, hasEvening].filter(Boolean).length;
  if (daypartWordCount >= 2) {
    s = { ...s, daypart: "any" };
  }

  // (b) 原文明確出現時段詞、但 model 漏填（daypart=any）→ 由原文補回（雙向覆核）
  if (daypartWordCount < 2 && s.daypart === "any") {
    if (hasAfternoon) s = { ...s, daypart: "afternoon" };
    else if (hasMorning) s = { ...s, daypart: "morning" };
    else if (hasEvening) s = { ...s, daypart: "evening" };
  }

  // 2.4 明確時長由 deterministic parser 覆核（如「一個半小時」=90），避免模型算成 30。
  const explicitDuration = durationMinutesFromText(rawText);
  if (explicitDuration !== null) s = { ...s, duration_minutes: explicitDuration };

  // 2.45 最高級排序同樣由後端覆核：「壓軸/最後一場」= last、「最早/第一場」= first。
  const explicitOrder = orderFromText(rawText);
  if (explicitOrder) s = { ...s, order: explicitOrder };

  // 2.5 filter_keyword 覆核（安全網）：14B 常把「會/會議/行程」這類泛詞、佔位符「X」、
  //     或原文根本沒出現的詞塞進 filter_keyword，害查詢被錯誤縮限。凡是——
  //       (a) 泛用名詞、(b) 佔位/單字母、(c) 原文未出現 —— 一律清掉。
  //     真正的過濾詞（跟「客戶」的會）必為原文子字串，故以原文出現與否把關。
  if (s.filter_keyword && isNoiseKeyword(s.filter_keyword, rawText)) {
    s = { ...s, filter_keyword: null };
  }

  // 2.55 疑問限定詞「哪」= 要求指認，不是要求數量（「大會議室被用在哪幾場會」問的是哪幾場，
  //      不是幾場）。這是封閉的疑問詞語法，不牽涉任何主題詞彙。
  if (s.intent === "count" && /哪[幾几]?\s*[場场個个件筆笔次]|哪些/.test(rawText)) {
    s = { ...s, intent: "list" };
  }

  // find_free 問的是整體空檔，filter_keyword 不參與 availability 計算；模型常把
  // 「拿來做簡報／打電話」的用途誤當事件標題。統一清掉，避免回覆製造假精確範圍。
  if (s.intent === "find_free") s = { ...s, filter_keyword: null };

  // 3. group 覆核（覆核後可能把誤判 group 併入 keyword，故再過一次雜訊過濾）
  const g = reconcileGroup(s, rawText, groupNames);
  if (g.intent === "find_free") return { ...g, filter_keyword: null };
  if (g.filter_keyword && isNoiseKeyword(g.filter_keyword, rawText)) {
    return { ...g, filter_keyword: null };
  }
  return g;
}

/** 泛詞 / 佔位 / 原文未出現的 filter_keyword 視為雜訊，應清掉。 */
const GENERIC_KEYWORDS = new Set([
  "會", "會議", "行程", "事", "事情", "活動", "安排", "日程", "行事曆", "行事历",
  "meeting", "meetings", "event", "events", "schedule", "x", "X",
  // 日文（實測「明日の予定は？」會把「明日」當關鍵字）
  "予定", "会議",
]);
/**
 * 時間／時段／問句詞：這些**絕不是**事件標題關鍵字。
 *
 * 實測 14B 很常把它們塞進 filter_keyword，結果把查詢縮限到查不到任何東西，
 * 於是回「沒有排定的會議或行程」——但其實有行程（問 A 答 B 的錯答）：
 *   「不好意思想問一下我明天的安排」→ filter="明天的安排" → 錯答沒有行程
 *   「明日の予定は？」            → filter="明日"       → 錯答沒有行程
 *   「今天晚上有安排嗎」          → filter="晚上"       → 訊息還變成「晚上「晚上」」
 */
/** 日曆泛稱（會／會議／行程…）的 regex 版本，與 GENERIC_KEYWORDS 同源，供覆蓋檢查使用。 */
export const CALENDAR_GENERIC_NOUNS = /會議|會|行程|日程|行事曆|日曆項目|活動|事情|事項|事|預約|meeting|meetings|event|events|schedule/g;

export const TIME_WORDS =
  /今天|明天|後天|昨天|前天|今日|明日|昨日|本日|這週|本週|下週|上週|這周|下周|上周|這禮拜|下禮拜|上禮拜|這個月|本月|下個月|上個月|月底|月初|週末|周末|平日|早上|上午|中午|下午|傍晚|晚上|晚間|夜間|今晚|明早|凌晨|整天|全天|最近|接下來|星期[一二三四五六日天]|週[一二三四五六日天]|禮拜[一二三四五六日天]/g;
/**
 * 序數／極值詞：同樣不是標題關鍵字。
 * 實測「明天最後一個行程是什麼」會把「最後一個行程」當 filter_keyword，
 * 結果錯答「沒有排定的會議或行程」。
 */
export const ORDINAL_WORDS = /最後一?[個場件]?|最早|最晚|最末|最前|第[一二三四五六七八九十]?[個場件]|下一[個場件]|上一[個場件]/g;
/** 指示代名詞（那個/這場…）是回指語法，不是事件標題。 */
const DEICTIC_WORDS = /那一?[個場筆件次]|這一?[個場筆件次]|該[場個筆]|它/g;

export function isNoiseKeyword(kw: string, rawText: string): boolean {
  const k = kw.trim();
  if (!k) return true;
  if (GENERIC_KEYWORDS.has(k) || GENERIC_KEYWORDS.has(k.toLowerCase())) return true;
  if (k.length === 1) return true; // 單字/單字母佔位（含全形 X）
  // 14B 幻想出來、原文根本沒有的過濾詞 → 不可信
  if (!rawText.includes(k)) return true;
  // 把「整句（或幾乎整句）」當成關鍵字 → 一定查不到東西，會錯答「沒有行程」。
  // 實測：問「明天有哪些行程'; DROP TABLE events; --」時 14B 把整句塞進 filter_keyword，
  // 於是回「沒有排定的會議或行程」（其實有 4 筆）。
  // 門檻刻意保守：短關鍵字即使占比高也放行（「不存在小組」對「不存在小組的會」是合理的
  // 過濾詞），只擋「絕對長度過長」或「夠長且幾乎等於整句」。
  const compact = (s: string) => s.replace(/\s+/g, "");
  const kLen = compact(k).length;
  if (kLen > 20) return true;
  if (kLen >= 10 && kLen >= compact(rawText).length * 0.8) return true;
  // 含問句用詞或程式碼/注入樣式字元的「關鍵字」不是真的標題關鍵字
  if (/有哪些|有什麼|幾個|嗎|請問|幫我/.test(k)) return true;
  if (/['";]|--|\bDROP\b|\bSELECT\b|[\n\r]/i.test(k)) return true;
  // 去掉時間詞、泛詞與虛詞後若「完全不剩」，就只是把時間／時段當成了關鍵字。
  // 門檻用「完全為空」而非「少於 2 字」：像「會議1」剝掉「會議」只剩「1」，
  // 那仍是合法的標題關鍵字（實測 INAPP-A-會議1），不可誤殺。
  const residue = k
    .replace(TIME_WORDS, "")
    .replace(ORDINAL_WORDS, "")
    .replace(DEICTIC_WORDS, "")
    .replace(/會議|會|行程|事情|事|活動|安排|日程|日曆|日历|行事曆|行事历|項目|项目|預定|予定|calendar\s*items?|的|之|我|有|要|開|是|了|呢|吧|喔|啊|，|,|。|\s/gi, "")
    .trim();
  if (residue.length === 0) return true;
  return false;
}

/**
 * group 覆核：14B 常把「產品團隊」拆成 group_name="團隊" + filter="產品"。
 * 用真實 group 清單兜正：
 *  - 若原始問句包含某真實 group 全名 → group_name = 該全名，清掉被誤拆的 keyword
 *  - 否則若 group_name 是某真實 group 的子字串 → 補成全名
 *  - 都對不上 → group_name 視為過濾詞併入 filter_keyword（不強加不存在的群組）
 */
export function reconcileGroup(spec: QuerySpec, rawText: string, groupNames: string[]): QuerySpec {
  const text = rawText;
  // 1. 問句直接含某真實 group 全名 → 最可靠
  const exact = groupNames.find((g) => g && text.includes(g));
  if (exact) {
    return { ...spec, group_name: exact, filter_keyword: spec.filter_keyword === exact ? null : spec.filter_keyword };
  }
  // 1.5 原文含某真實 group 的「核心詞」→ 用原文比對（比信任 14B 拆出的殘詞可靠）。
  //     核心詞 = 群組全名去掉泛型後綴（團隊/小隊/團/隊/組/群組）與空白後的顯著詞元
  //     （如「Alpha 小隊」→「alpha」、「產品團隊」→「產品」）。原文出現該核心詞才算命中，
  //     且僅當恰好一個群組命中時採用，避免歧義誤判。
  const lower = text.toLowerCase();
  const coreOf = (g: string) =>
    g.replace(/團隊|小隊|群組|團|隊|組|群|\s+/g, "").toLowerCase();
  const byCore = groupNames.filter((g) => {
    const core = coreOf(g);
    return core.length >= 2 && lower.includes(core);
  });
  if (byCore.length === 1) {
    const g = byCore[0];
    // 事件標題優先：只有當關鍵字「嚴格長於」群組核心詞、且把核心詞包在裡面時，才代表
    // 使用者點名的是某一場會議（如 keyword=「產品週會」對核心「產品」）。若兩者等長，
    // 那只是 14B 把群組名拆碎（keyword=「Alpha」對「Alpha 小隊」），仍應套用群組。
    const core = coreOf(g);
    const kwLower = spec.filter_keyword?.toLowerCase() ?? "";
    if (
      spec.filter_keyword &&
      core.length >= 2 &&
      kwLower.includes(core) &&
      kwLower.length > core.length &&
      spec.filter_keyword !== g
    ) {
      return { ...spec, group_name: null };
    }
    const kw = spec.filter_keyword && g.includes(spec.filter_keyword) ? null : spec.filter_keyword;
    return { ...spec, group_name: g, filter_keyword: kw };
  }
  // 2. 抽出的 group_name / (group_name+keyword 拼接) 是某真實 group 的子字串。
  //    但只在「抽出詞夠長（≥2 且非泛型後綴）」時才做，避免拿「隊」「組」這類殘詞誤中。
  if (spec.group_name) {
    const gn = spec.group_name.trim();
    const isSuffixOnly = /^(團隊|小隊|群組|團|隊|組|群)$/.test(gn);
    if (!isSuffixOnly && gn.length >= 2) {
      const combined = `${spec.filter_keyword ?? ""}${gn}`;
      const bySub = groupNames.find((g) => g.includes(gn) || g.includes(combined) || combined.includes(g));
      if (bySub) return { ...spec, group_name: bySub, filter_keyword: null };
    }
    // 3. 對不上任何真實群組 → 併入關鍵字過濾，不強加不存在的群組
    return { ...spec, group_name: null, filter_keyword: spec.filter_keyword ?? (isSuffixOnly ? null : spec.group_name) };
  }
  return spec;
}

const SYSTEM =
  "你是日曆查詢解析器。把使用者的中文問題轉成結構化查詢參數。只填欄位、不要解釋、不要自己算日期。規則：" +
  "問『有哪些/有什麼會』→intent=list；問『幾個/多少』→count；問『有沒有空/空檔』→find_free；問『待回覆/誰約我』→pending。" +
  "『下午』→daypart=afternoon，『上午/早上』→morning，『晚上』→evening，未指明→any。" +
  "『跟X的會』→filter_keyword=X。『X團隊/X小隊』整個當 group_name（不要拆開）。" +
  "『第一個/最早』→order=first，『下一個』→next。無明確時間→anchor=none。" +
  "沒有的欄位一律填 null（不要填 \":null\"、\"none\" 這種字串）。" +
  "星期：週一=0 週二=1 週三=2 週四=3 週五=4 週六=5 週日=6。";

/**
 * 用 model 抽 QuerySpec（失敗回 null，由呼叫端 fallback 規則）。
 * 抽完一律 normalizeSpec；group 覆核在呼叫端進行（需 DB 的真實 group 清單）。
 */
export async function extractQuerySpec(text: string, model: ChatModel): Promise<QuerySpec | null> {
  try {
    const raw = await model.invokeStructured(QuerySpecSchema, [
      { role: "system", content: SYSTEM },
      { role: "human", content: "今天有什麼會" },
      { role: "human", content: text },
    ]);
    return normalizeSpec(raw as Partial<QuerySpec>);
  } catch {
    return null;
  }
}
