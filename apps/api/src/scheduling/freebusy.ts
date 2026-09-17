export interface Interval {
  start: number; // epoch ms
  end: number;
}

export interface Slot {
  start_utc: string;
  end_utc: string;
  score: number;
}

/** 合併重疊/相鄰的忙碌區間（掃描線）。 */
export function mergeBusy(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** 忙碌集合的補集 = 窗口內空檔（free）。 */
export function freeGaps(busy: Interval[], windowStart: number, windowEnd: number): Interval[] {
  const merged = mergeBusy(busy.filter((b) => b.end > windowStart && b.start < windowEnd));
  const gaps: Interval[] = [];
  let cursor = windowStart;
  for (const b of merged) {
    const bs = Math.max(b.start, windowStart);
    if (bs > cursor) gaps.push({ start: cursor, end: bs });
    cursor = Math.max(cursor, Math.min(b.end, windowEnd));
  }
  if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });
  return gaps;
}

/**
 * 找出可容納 durationMs 的候選時段（REQ-S1）。
 * 評分：越早越高（就近），並對齊整點/半點加分（避免破碎）。
 */
export function findSlots(
  busy: Interval[],
  windowStart: number,
  windowEnd: number,
  durationMs: number,
  maxResults = 5,
): Slot[] {
  const gaps = freeGaps(busy, windowStart, windowEnd);
  const slots: Slot[] = [];
  const totalWindow = windowEnd - windowStart || 1;
  for (const g of gaps) {
    let s = g.start;
    while (s + durationMs <= g.end) {
      const proximity = 1 - (s - windowStart) / totalWindow; // 越早越高
      const minute = new Date(s).getUTCMinutes();
      const aligned = minute === 0 || minute === 30 ? 0.1 : 0;
      slots.push({
        start_utc: new Date(s).toISOString(),
        end_utc: new Date(s + durationMs).toISOString(),
        score: Math.min(1, Number((proximity + aligned).toFixed(3))),
      });
      s += durationMs; // 非重疊候選
    }
  }
  return slots.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/** 衝突偵測：新區間是否與既有忙碌重疊。 */
export function detectConflicts(candidate: Interval, busy: Interval[]): Interval[] {
  return busy.filter((b) => b.start < candidate.end && candidate.start < b.end);
}
