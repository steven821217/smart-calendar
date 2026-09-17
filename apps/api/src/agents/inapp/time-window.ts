/**
 * 查詢用「時間窗」確定性解析（harness 核心）。
 *
 * 為何不交給 model：14B 本地 model 算日期/時區極不可靠。查詢的時間窗（今天、明天、
 * 這週…）用規則在後端算成 [from_utc, to_utc]，model 完全不碰日期，只負責「選意圖」與
 * 「複述結果」。
 *
 * 時區換算不引入 date-fns-tz（api 僅有 date-fns）；改用 Intl 求某 UTC 時刻在目標時區的
 * 偏移，據此推當地午夜對應的 UTC。
 */

export interface TimeWindow {
  from_utc: string;
  to_utc: string;
  label: string; // 人類可讀窗標籤，用於模板回答
}

/** 目標時區相對 UTC 的偏移（分鐘），以某 UTC 瞬時 d 求值（處理 DST）。 */
function tzOffsetMinutes(d: Date, tz: string): number {
  // 以 tz 格式化出的「牆上時間」與同一時刻的 UTC 牆上時間之差即為偏移。
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = dtf.formatToParts(d).reduce<Record<string, number>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asUTC = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second,
  );
  return (asUTC - d.getTime()) / 60_000;
}

/** 取 tz 當地某日（今天 + addDays）00:00 對應的 UTC Date。 */
function localMidnightUtc(nowUtc: Date, tz: string, addDays: number): Date {
  const off = tzOffsetMinutes(nowUtc, tz);
  // nowUtc 對應的當地牆上時間
  const localMs = nowUtc.getTime() + off * 60_000;
  const local = new Date(localMs);
  // 當地日期的 00:00（用 UTC getters 讀「已平移」的當地牆上時間）
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const day = local.getUTCDate() + addDays;
  const localMidnightAsMs = Date.UTC(y, m, day, 0, 0, 0);
  // 該當地午夜對應的真正 UTC（再用該時刻的偏移回推，處理跨 DST）
  const approx = new Date(localMidnightAsMs - off * 60_000);
  const off2 = tzOffsetMinutes(approx, tz);
  return new Date(localMidnightAsMs - off2 * 60_000);
}

function label(nowUtc: Date, tz: string, addDays: number, base: string): string {
  const d = localMidnightUtc(nowUtc, tz, addDays);
  const md = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", timeZone: tz }).format(d);
  return `${base}（${md}）`;
}

function span(nowUtc: Date, tz: string, dayOffset: number, spanDays: number, lbl: string): TimeWindow {
  return {
    from_utc: localMidnightUtc(nowUtc, tz, dayOffset).toISOString(),
    to_utc: localMidnightUtc(nowUtc, tz, dayOffset + spanDays).toISOString(),
    label: lbl,
  };
}

/** 週一=0 的星期索引（依 tz 當地）。 */
function localDow(nowUtc: Date, tz: string): number {
  const off = tzOffsetMinutes(nowUtc, tz);
  const local = new Date(nowUtc.getTime() + off * 60_000);
  return (local.getUTCDay() + 6) % 7;
}

/**
 * 規則解析時間窗；命中回 TimeWindow，未命中回 null。
 * 先比對較長片語（後天/下週）再比對短的（明天/這週），避免子字串誤吞。
 */
export function resolveTimeWindow(text: string, tz: string, nowUtc = new Date()): TimeWindow | null {
  const t = text.toLowerCase();

  if (/後天|day after tomorrow/.test(t)) return span(nowUtc, tz, 2, 1, label(nowUtc, tz, 2, "後天"));
  if (/明天|明日|tomorrow/.test(t)) return span(nowUtc, tz, 1, 1, label(nowUtc, tz, 1, "明天"));
  if (/今天|今日|today|今晚|今早/.test(t)) return span(nowUtc, tz, 0, 1, label(nowUtc, tz, 0, "今天"));
  if (/下週|下周|next week/.test(t)) {
    const toNextMon = 7 - localDow(nowUtc, tz);
    return span(nowUtc, tz, toNextMon, 7, "下週");
  }
  if (/這週|本週|这周|this week|這禮拜|這星期/.test(t)) {
    const toSun = 7 - localDow(nowUtc, tz);
    return span(nowUtc, tz, 0, toSun, "這週");
  }
  const n = t.match(/接下來\s*(\d{1,2})\s*天|next\s+(\d{1,2})\s+days?/);
  if (n) {
    const days = Number(n[1] ?? n[2]);
    if (days > 0 && days <= 60) return span(nowUtc, tz, 0, days, `接下來 ${days} 天`);
  }
  return null;
}

/** 預設窗：今天起 7 天。 */
export function defaultWindow(tz: string, nowUtc = new Date()): TimeWindow {
  return span(nowUtc, tz, 0, 7, "接下來 7 天");
}

/** daypart → 當地小時區間 [startHour, endHour)。 */
export function daypartHours(daypart: string): [number, number] | null {
  switch (daypart) {
    case "morning": return [6, 12];
    case "afternoon": return [12, 18];
    case "evening": return [18, 24];
    default: return null; // any
  }
}

/** 某 occurrence 的當地小時（用於 daypart 過濾）。 */
export function localHour(utcIso: string, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(utcIso));
  const n = Number(h);
  return n === 24 ? 0 : n;
}

/**
 * 由 anchor / weekday 範圍算時間窗（後端算日期，14B 不算）。
 * 優先序：weekday 範圍（週三到週五）> anchor（today/this_week…）> 預設。
 */
export function windowFromSpec(
  anchor: string,
  weekdayFrom: number | null,
  weekdayTo: number | null,
  tz: string,
  nowUtc = new Date(),
): TimeWindow {
  // weekday 範圍：本週內從 weekdayFrom 到 weekdayTo（含）；anchor=next_week 則整體 +7 天
  if (weekdayFrom !== null) {
    const from = weekdayFrom;
    const to = weekdayTo ?? weekdayFrom;
    const curDow = localDow(nowUtc, tz);
    const weekShift = anchor === "next_week" ? 7 : 0;
    const startOffset = from - curDow + weekShift;
    const endOffset = to - curDow + 1 + weekShift; // 含結束日整日
    const s = span(nowUtc, tz, startOffset, endOffset - startOffset, "");
    const names = ["一", "二", "三", "四", "五", "六", "日"];
    const wk = anchor === "next_week" ? "下週" : "本週";
    return { ...s, label: `${wk}週${names[from]}${to !== from ? `至週${names[to]}` : ""}` };
  }
  switch (anchor) {
    case "today": return { ...span(nowUtc, tz, 0, 1, ""), label: label(nowUtc, tz, 0, "今天") };
    case "tomorrow": return { ...span(nowUtc, tz, 1, 1, ""), label: label(nowUtc, tz, 1, "明天") };
    case "day_after_tomorrow": return { ...span(nowUtc, tz, 2, 1, ""), label: label(nowUtc, tz, 2, "後天") };
    case "this_week": return span(nowUtc, tz, 0, 7 - localDow(nowUtc, tz), "這週");
    case "next_week": { const m = 7 - localDow(nowUtc, tz); return span(nowUtc, tz, m, 7, "下週"); }
    case "this_month": return monthWindow(tz, nowUtc);
    default: return defaultWindow(tz, nowUtc);
  }
}

/** 本月剩餘（今天起到月底）窗。 */
function monthWindow(tz: string, nowUtc: Date): TimeWindow {
  const off = tzOffsetMinutes(nowUtc, tz);
  const local = new Date(nowUtc.getTime() + off * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const firstNextMonthMs = Date.UTC(y, m + 1, 1, 0, 0, 0);
  const off2 = tzOffsetMinutes(new Date(firstNextMonthMs - off * 60_000), tz);
  return {
    from_utc: localMidnightUtc(nowUtc, tz, 0).toISOString(),
    to_utc: new Date(firstNextMonthMs - off2 * 60_000).toISOString(),
    label: "這個月",
  };
}
