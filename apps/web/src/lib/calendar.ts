import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addDays,
  isSameDay,
  isSameMonth,
} from "date-fns";
import { toZonedTime } from "date-fns-tz";

/** 週起始：週一（ISO）。可日後做成使用者偏好。 */
const WEEK_STARTS_ON = 1 as const;

/** 月視圖 42 格（6 週 × 7 天），含補滿前後月的日子。日期以觀看者時區的「今天」為基準。 */
export function monthGridDays(anchor: Date): Date[] {
  const first = startOfMonth(anchor);
  const last = endOfMonth(anchor);
  const gridStart = startOfWeek(first, { weekStartsOn: WEEK_STARTS_ON });
  const gridEnd = endOfWeek(last, { weekStartsOn: WEEK_STARTS_ON });
  return eachDayOfInterval({ start: gridStart, end: gridEnd });
}

/** 週視圖 7 天。 */
export function weekGridDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor, { weekStartsOn: WEEK_STARTS_ON });
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 觀看者時區「現在」對應的 Date（其 local 欄位即該時區時鐘）。 */
export function nowInViewer(tz: string): Date {
  return toZonedTime(new Date(), tz);
}

export { isSameDay, isSameMonth, addDays };
