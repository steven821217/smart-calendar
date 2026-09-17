import type { Occurrence } from "@/lib/api";
import { viewerWallToUtc, utcToViewer } from "@/lib/time";

/**
 * 拖曳（9.3, UI-20/21）：draggable = 事件 occurrence；droppable = 月日格 / 週時段。
 * dnd-kit 的 id 用字串編碼落點，onDragEnd 於 CalendarPage 解碼並換算新 UTC。
 */

export interface DragData {
  occ: Occurrence;
}

// droppable id 編碼
export function monthCellId(dayIso: string): string {
  return `month-cell:${dayIso}`;
}
export function weekSlotId(dayIso: string, minutes: number): string {
  return `week-slot:${dayIso}:${minutes}`;
}

export interface DropTarget {
  kind: "month" | "week";
  dayIso: string; // 該日 00:00（觀看者牆上時間）的 ISO
  minutes?: number; // 週視圖：自午夜起算分鐘（snap 後）
}

export function parseDropId(id: string): DropTarget | null {
  if (id.startsWith("month-cell:")) {
    return { kind: "month", dayIso: id.slice("month-cell:".length) };
  }
  if (id.startsWith("week-slot:")) {
    const rest = id.slice("week-slot:".length);
    const i = rest.lastIndexOf(":");
    return { kind: "week", dayIso: rest.slice(0, i), minutes: Number(rest.slice(i + 1)) };
  }
  return null;
}

/**
 * 依落點算新的 start_utc / end_utc（保留時長）。
 * - month：換日期，保留原本的時分（觀看者時區）。
 * - week：換日期 + 時段（snap 後的分鐘），保留時長。
 * 全程以觀看者 IANA 換算（UI-21），不自行加減時差。
 */
export function computeNewTimes(
  occ: Occurrence,
  target: DropTarget,
  tz: string,
): { start_utc: string; end_utc: string } {
  const durationMs =
    new Date(occ.occurrence_end_utc).getTime() - new Date(occ.occurrence_start_utc).getTime();

  // 目標日的牆上時間基準（該日 00:00）
  const [y, mo, d] = target.dayIso.split("T")[0].split("-").map(Number);

  let hh: number;
  let mi: number;
  if (target.kind === "month") {
    // 保留原本時分
    const orig = utcToViewer(occ.occurrence_start_utc, tz);
    hh = orig.getHours();
    mi = orig.getMinutes();
  } else {
    const total = target.minutes ?? 0;
    hh = Math.floor(total / 60);
    mi = total % 60;
  }

  const wall = new Date(y, mo - 1, d, hh, mi, 0, 0);
  const startUtc = viewerWallToUtc(wall, tz);
  const endUtc = new Date(startUtc.getTime() + durationMs);
  return { start_utc: startUtc.toISOString(), end_utc: endUtc.toISOString() };
}

/** 週視圖 snap 到 15 分。 */
export function snap15(minutes: number): number {
  return Math.round(minutes / 15) * 15;
}
