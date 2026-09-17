import { fromZonedTime, toZonedTime, format as formatTz } from "date-fns-tz";

/**
 * 時區處理（UI-2/18）：後端存/回 UTC，前端僅依觀看者 IANA 換算「顯示」，
 * 絕不自行加減時差；DST 由 date-fns-tz 處理。
 */

/** 觀看者 IANA 下的「牆上時間」Date（其 local 欄位反映該時區的時鐘）。 */
export function utcToViewer(utcIso: string, tz: string): Date {
  return toZonedTime(new Date(utcIso), tz);
}

/** 觀看者時區的牆上時間 → 真正的 UTC 瞬時（拖曳落點換算用）。 */
export function viewerWallToUtc(wall: Date, tz: string): Date {
  return fromZonedTime(wall, tz);
}

/** 依觀看者時區格式化 UTC 時間。 */
export function fmt(utcIso: string, tz: string, pattern: string): string {
  return formatTz(toZonedTime(new Date(utcIso), tz), pattern, { timeZone: tz });
}

/** hh:mm（觀看者時區）。 */
export function fmtTime(utcIso: string, tz: string): string {
  return fmt(utcIso, tz, "HH:mm");
}

/** 該 occurrence 在觀看者時區「當天 00:00 起算」的分鐘 offset（週視圖定位用）。 */
export function minutesFromMidnight(utcIso: string, tz: string): number {
  const z = toZonedTime(new Date(utcIso), tz);
  return z.getHours() * 60 + z.getMinutes();
}

/** 兩個 UTC 時間的分鐘差（時長）。 */
export function durationMinutes(startUtc: string, endUtc: string): number {
  return (new Date(endUtc).getTime() - new Date(startUtc).getTime()) / 60000;
}

/** 該時區當下相對 UTC 的偏移標籤，如 "GMT+8"（雙時區顯示用）。 */
export function tzOffsetLabel(utcIso: string, tz: string): string {
  // 用 Intl 取短時區名（含偏移）
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(utcIso));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

/**
 * 跨時區雙時區顯示（UI-2）：當事件原始時區 eventTz 與觀看者 viewerTz 不同時，
 * 回傳 "觀看者時間 (GMT+x) · 原始時間 (GMT+y)"；相同則只回觀看者時間。
 */
export function dualTz(utcIso: string, viewerTz: string, eventTz: string): string {
  const viewer = `${fmtTime(utcIso, viewerTz)} ${tzOffsetLabel(utcIso, viewerTz)}`;
  if (!eventTz || eventTz === viewerTz) return viewer;
  const origin = `${fmtTime(utcIso, eventTz)} ${tzOffsetLabel(utcIso, eventTz)}`;
  return `${viewer} · ${origin}`;
}
