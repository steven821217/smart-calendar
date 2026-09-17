import { z } from "zod";

/**
 * 規則式 NL 事件解析（REQ-S3 / 5.4）。
 *
 * 設計：`Parser` 介面 + 預設 `RuleBasedParser`，日後可換 LLM 不動上層（design.md §4.4）。
 * 產出「草稿」（draft），非直接建立——由使用者一鍵確認後才呼叫 POST /v1/events。
 * 時間一律轉為 UTC ISO-8601（TZ-2）；牆上時間依 `default_timezone`（IANA）換算。
 */

export const ParseInput = z.object({
  text: z.string().min(1).max(1000),
  reference_now_utc: z.string().datetime().optional(),
  default_timezone: z.string().min(1), // IANA
});
export type ParseInputT = z.infer<typeof ParseInput>;

export const EventDraft = z.object({
  title: z.string(),
  start_utc: z.string().datetime(),
  end_utc: z.string().datetime(),
  timezone: z.string(),
  all_day: z.boolean().default(false),
  rrule: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  // 供 UI 標示哪些欄位是推斷、哪些缺漏需人工補
  warnings: z.array(z.string()).default([]),
});
export type EventDraftT = z.infer<typeof EventDraft>;

export interface Parser {
  parse(input: ParseInputT): EventDraftT;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, 星期日: 0, 週日: 0, 禮拜日: 0,
  monday: 1, mon: 1, 星期一: 1, 週一: 1, 禮拜一: 1,
  tuesday: 2, tue: 2, tues: 2, 星期二: 2, 週二: 2, 禮拜二: 2,
  wednesday: 3, wed: 3, 星期三: 3, 週三: 3, 禮拜三: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, 星期四: 4, 週四: 4, 禮拜四: 4,
  friday: 5, fri: 5, 星期五: 5, 週五: 5, 禮拜五: 5,
  saturday: 6, sat: 6, 星期六: 6, 週六: 6, 禮拜六: 6,
};

const RRULE_BY_WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** 取得某 IANA 時區在給定 UTC 瞬時的位移（分鐘，東為正）。 */
function tzOffsetMinutes(dateUtc: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(dateUtc);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour === "24" ? "0" : map.hour), Number(map.minute), Number(map.second),
  );
  return Math.round((asUtc - dateUtc.getTime()) / 60_000);
}

/** 將某時區的牆上時間（y-m-d h:m）轉為 UTC 瞬時（處理 DST，TZ-6）。 */
function wallTimeToUtc(
  y: number, mo: number, d: number, h: number, mi: number, timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  // 兩次逼近以吸收 DST 邊界
  let offset = tzOffsetMinutes(new Date(guess), timeZone);
  let utc = guess - offset * 60_000;
  offset = tzOffsetMinutes(new Date(utc), timeZone);
  utc = guess - offset * 60_000;
  return new Date(utc);
}

/** 取某 UTC 瞬時在時區下的牆上日期分量。 */
function wallParts(dateUtc: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(dateUtc)) map[p.type] = p.value;
  return {
    y: Number(map.year), mo: Number(map.month), d: Number(map.day),
    h: Number(map.hour === "24" ? "0" : map.hour), mi: Number(map.minute),
  };
}

export class RuleBasedParser implements Parser {
  parse(input: ParseInputT): EventDraftT {
    const now = input.reference_now_utc ? new Date(input.reference_now_utc) : new Date();
    const tz = input.default_timezone;
    const text = input.text.trim();
    const lower = text.toLowerCase();
    const warnings: string[] = [];
    let confidence = 0.5;

    // 觀看者時區「今天」的牆上日期
    const today = wallParts(now, tz);
    let y = today.y, mo = today.mo, d = today.d;

    // --- 相對日 ---
    const addDays = (n: number) => {
      const base = wallTimeToUtc(today.y, today.mo, today.d, 12, 0, tz); // 正午避開 DST
      const shifted = wallParts(new Date(base.getTime() + n * 86_400_000), tz);
      y = shifted.y; mo = shifted.mo; d = shifted.d;
    };
    if (/\btomorrow\b|明天|明日/.test(lower)) { addDays(1); confidence += 0.15; }
    else if (/\bday after tomorrow\b|後天/.test(lower)) { addDays(2); confidence += 0.15; }
    else if (/\btoday\b|今天|今日/.test(lower)) { confidence += 0.1; }

    // --- 明確日期 YYYY-MM-DD 或 M/D ---
    const iso = lower.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    const md = lower.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; confidence += 0.2; }
    else if (md) { mo = +md[1]; d = +md[2]; confidence += 0.15; }

    // --- 星期幾（取「下一個」該星期幾，含今天則今天）---
    let rrule: string | null = null;
    for (const [word, wd] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i").test(text)) {
        const cur = wallParts(now, tz);
        // 用觀看者時區下的牆上日期算星期幾
        const dow = new Date(Date.UTC(cur.y, cur.mo - 1, cur.d)).getUTCDay();
        let delta = (wd - dow + 7) % 7;
        if (delta === 0 && !/today|今天|今日/.test(lower)) delta = 7; // 沒說今天 → 下週該日
        addDays(delta);
        confidence += 0.15;
        if (/\bevery\b|每(週|周|个星期|星期)/.test(lower)) {
          rrule = `FREQ=WEEKLY;BYDAY=${RRULE_BY_WEEKDAY[wd]}`;
          confidence += 0.1;
        }
        break;
      }
    }
    if (!rrule && /\bevery day\b|每天|每日/.test(lower)) rrule = "FREQ=DAILY";
    if (!rrule && /\bevery week\b|每週|每周/.test(lower)) rrule = "FREQ=WEEKLY";

    // --- 時間 ---
    let h = 9, mi = 0, allDay = false, gotTime = false;
    const t12 = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    const t24 = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    const cn = text.match(/(上午|下午|早上|晚上|中午)?\s*(\d{1,2})\s*[點点时]\s*(\d{1,2})?\s*分?/);
    if (t12) {
      h = +t12[1] % 12; if (t12[3] === "pm") h += 12;
      mi = t12[2] ? +t12[2] : 0; gotTime = true; confidence += 0.2;
    } else if (t24) {
      h = +t24[1]; mi = +t24[2]; gotTime = true; confidence += 0.2;
    } else if (cn) {
      h = +cn[2]; mi = cn[3] ? +cn[3] : 0;
      const mer = cn[1];
      if ((mer === "下午" || mer === "晚上") && h < 12) h += 12;
      if (mer === "中午") h = 12;
      gotTime = true; confidence += 0.2;
    } else if (/\ball day\b|全天|整天/.test(lower)) {
      allDay = true; h = 0; mi = 0; gotTime = true; confidence += 0.1;
    } else {
      warnings.push("time not detected, defaulted to 09:00");
    }

    // --- 時長 ---
    let durationMin = allDay ? 24 * 60 : 60;
    const durH = lower.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|小時|小时)/);
    const durM = lower.match(/(\d+)\s*(minutes?|mins?|分鐘|分钟)/);
    if (durH) { durationMin = Math.round(parseFloat(durH[1]) * 60); confidence += 0.05; }
    else if (durM) { durationMin = +durM[1]; confidence += 0.05; }

    // --- 標題（移除已識別的時間/日期詞，取剩餘為標題）---
    let title = text
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, "")
      .replace(/\b\d{1,2}\/\d{1,2}\b/g, "")
      .replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/gi, "")
      .replace(/\b\d{1,2}:\d{2}\b/g, "")
      .replace(/(上午|下午|早上|晚上|中午)?\s*\d{1,2}\s*[點点时]\s*\d{0,2}\s*分?/g, "")
      .replace(/\b(tomorrow|today|day after tomorrow|every day|every week|all day|next|at|on|for|每天|每日|明天|明日|後天|今天|今日|全天|整天)\b/gi, "")
      .replace(/(每週|每周|每星期)/g, "")
      .replace(/\b\d+(?:\.\d+)?\s*(hours?|hrs?|minutes?|mins?)\b/gi, "")
      .replace(/(\d+\s*(小時|小时|分鐘|分钟))/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,，.。:：-]+|[\s,，.。:：-]+$/g, "")
      .trim();
    for (const word of Object.keys(WEEKDAYS)) {
      title = title.replace(new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "gi"), "$1$2");
    }
    title = title.replace(/\s{2,}/g, " ").trim();
    if (!title) { title = "New event"; warnings.push("title not detected"); confidence -= 0.1; }

    const startUtc = wallTimeToUtc(y, mo, d, h, mi, tz);
    const endUtc = new Date(startUtc.getTime() + durationMin * 60_000);

    return EventDraft.parse({
      title,
      start_utc: startUtc.toISOString(),
      end_utc: endUtc.toISOString(),
      timezone: tz,
      all_day: allDay,
      rrule,
      confidence: Math.max(0, Math.min(1, confidence)),
      warnings,
    });
  }
}

/** 預設 parser 實例（規則式）。日後可注入 LLMParser 取代。 */
export const defaultParser: Parser = new RuleBasedParser();

export function parseEventFromText(input: ParseInputT): EventDraftT {
  return defaultParser.parse(ParseInput.parse(input));
}
