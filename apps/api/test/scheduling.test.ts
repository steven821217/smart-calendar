import { describe, it, expect } from "vitest";
import { mergeBusy, freeGaps, findSlots, detectConflicts } from "../src/scheduling/freebusy.js";

const H = (h: number) => new Date(`2026-09-15T${String(h).padStart(2, "0")}:00:00Z`).getTime();

describe("free/busy 排程 (REQ-S1/S2)", () => {
  it("合併重疊忙碌區間", () => {
    const m = mergeBusy([
      { start: H(9), end: H(10) },
      { start: H(9), end: H(11) },
      { start: H(13), end: H(14) },
    ]);
    expect(m).toHaveLength(2);
    expect(m[0].end).toBe(H(11));
  });

  it("補集空檔正確（9-17 窗口，忙 10-11、13-14）", () => {
    const gaps = freeGaps([{ start: H(10), end: H(11) }, { start: H(13), end: H(14) }], H(9), H(17));
    // 9-10, 11-13, 14-17
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toEqual({ start: H(9), end: H(10) });
  });

  it("找 60 分鐘候選時段，最早優先", () => {
    const slots = findSlots([{ start: H(10), end: H(11) }], H(9), H(12), 60 * 60 * 1000, 5);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].start_utc).toBe(new Date(H(9)).toISOString()); // 9-10 最早
  });

  it("衝突偵測：重疊回報，不重疊為空", () => {
    const busy = [{ start: H(10), end: H(11) }];
    expect(detectConflicts({ start: H(10), end: H(10) + 1 }, busy)).toHaveLength(1);
    expect(detectConflicts({ start: H(11), end: H(12) }, busy)).toHaveLength(0);
  });
});
