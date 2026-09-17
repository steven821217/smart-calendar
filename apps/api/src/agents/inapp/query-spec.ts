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
  anchor: z.enum(["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "this_month", "none"]),
  weekday_from: z.number().int().min(0).max(6).nullable(),
  weekday_to: z.number().int().min(0).max(6).nullable(),
  daypart: z.enum(["morning", "afternoon", "evening", "any"]),
  filter_keyword: z.string().nullable(),
  group_name: z.string().nullable(),
  order: z.enum(["first", "next", "none"]),
});
export type QuerySpec = z.infer<typeof QuerySpecSchema>;

const NULLISH = new Set([":null", ":none", "null", "none", "", "n/a", "無", "沒有"]);

/** 把 14B 常見的髒字串正規化成真 null；trim。 */
function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
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
  const anchor = (["today", "tomorrow", "day_after_tomorrow", "this_week", "next_week", "this_month", "none"] as const).includes(
    raw.anchor as never,
  )
    ? (raw.anchor as QuerySpec["anchor"])
    : "none";
  const daypart = (["morning", "afternoon", "evening", "any"] as const).includes(raw.daypart as never)
    ? (raw.daypart as QuerySpec["daypart"])
    : "any";
  const order = (["first", "next", "none"] as const).includes(raw.order as never)
    ? (raw.order as QuerySpec["order"])
    : "none";
  const wd = (n: unknown): number | null =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;

  return {
    intent,
    anchor,
    weekday_from: wd(raw.weekday_from),
    weekday_to: wd(raw.weekday_to),
    daypart,
    filter_keyword: cleanStr(raw.filter_keyword),
    group_name: cleanStr(raw.group_name),
    order,
  };
}

/**
 * 原文覆核（harness）：用「使用者原始問句」校正 14B 的雜訊輸出。
 * 1. 單日 anchor（today/tomorrow/day_after）優先於 weekday 範圍 —— 14B 常在指定「明天」時
 *    又亂填 weekday_from/to 全範圍，這裡清掉。
 * 2. daypart 只在原文真的出現時段詞時採用 —— 14B 常無中生有填 afternoon。
 * 3. group 覆核（reconcileGroup）：用真實 group 清單兜正中文誤拆。
 */
/**
 * 規則時間錨點（比 14B 準）：從原文抽明確時間詞 → { anchor, weekday_from, weekday_to }。
 * 命中回部分 spec 覆蓋；未命中回 null（沿用 14B）。
 * 單一星期（禮拜五/週三/星期一）直接算 weekday，這是 14B 最常判錯的地方。
 */
function ruleAnchor(text: string): Partial<QuerySpec> | null {
  const t = text.toLowerCase();
  // 單一星期（優先，因 14B 常把「這禮拜五」誤判 anchor）
  const wdMap: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
  const wm = text.match(/(?:這|本|下)?(?:個)?(?:禮拜|週|星期)([一二三四五六日天])/);
  if (wm) {
    const wd = wdMap[wm[1]];
    if (wd !== undefined) {
      const nextWeek = /下(?:個)?(?:禮拜|週|星期)/.test(text);
      // 下週的單一星期：用 anchor=next_week + weekday 定位；本週則 this_week + weekday
      return { anchor: nextWeek ? "next_week" : "this_week", weekday_from: wd, weekday_to: wd };
    }
  }
  if (/後天|day after tomorrow/.test(t)) return { anchor: "day_after_tomorrow", weekday_from: null, weekday_to: null };
  if (/明天|明日|tomorrow/.test(t)) return { anchor: "tomorrow", weekday_from: null, weekday_to: null };
  if (/今天|今日|today|今晚|今早/.test(t)) return { anchor: "today", weekday_from: null, weekday_to: null };
  if (/下週|下周|next week/.test(t)) return { anchor: "next_week", weekday_from: null, weekday_to: null };
  if (/這週|本週|这周|this week|這禮拜|這星期/.test(t)) return { anchor: "this_week", weekday_from: null, weekday_to: null };
  if (/這個月|本月|this month/.test(t)) return { anchor: "this_month", weekday_from: null, weekday_to: null };
  return null;
}

export function reconcileSpec(spec: QuerySpec, rawText: string, groupNames: string[]): QuerySpec {
  let s = { ...spec };

  // 0. 規則時間錨點覆核（規則比 14B 準）：原文若含明確時間詞，直接覆蓋 14B 的 anchor/weekday。
  const anchored = ruleAnchor(rawText);
  if (anchored) s = { ...s, ...anchored };

  // 1. 單日 anchor 優先：清掉 weekday 雜訊
  if (["today", "tomorrow", "day_after_tomorrow"].includes(s.anchor)) {
    s = { ...s, weekday_from: null, weekday_to: null };
  }

  // 2. daypart 原文覆核：問句沒出現時段詞 → 丟棄
  const hasMorning = /上午|早上|早晨/.test(rawText);
  const hasAfternoon = /下午/.test(rawText);
  const hasEvening = /晚上|傍晚|夜間/.test(rawText);
  const wordFor: Record<string, boolean> = { morning: hasMorning, afternoon: hasAfternoon, evening: hasEvening };
  if (s.daypart !== "any" && !wordFor[s.daypart]) {
    s = { ...s, daypart: "any" };
  }

  // 3. group 覆核
  return reconcileGroup(s, rawText, groupNames);
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
  // 2. 抽出的 group_name / (group_name+keyword 拼接) 是某真實 group 的子字串
  if (spec.group_name) {
    const combined = `${spec.filter_keyword ?? ""}${spec.group_name}`;
    const bySub = groupNames.find((g) => g.includes(spec.group_name!) || g.includes(combined) || combined.includes(g));
    if (bySub) return { ...spec, group_name: bySub, filter_keyword: null };
    // 3. 對不上任何真實群組 → 併入關鍵字過濾，不強加不存在的群組
    return { ...spec, group_name: null, filter_keyword: spec.filter_keyword ?? spec.group_name };
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
