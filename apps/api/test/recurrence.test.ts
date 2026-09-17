import { describe, it, expect } from "vitest";
import { expandOccurrences, type MasterEvent } from "../src/events/recurrence.js";

const base: MasterEvent = {
  id: "evt_1",
  title: "Weekly sync",
  start_utc: "2026-09-15T06:00:00Z", // 週二
  end_utc: "2026-09-15T06:30:00Z",
  timezone: "Asia/Taipei",
  rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=4",
};

describe("recurrence 展開 (REC-*)", () => {
  it("單次事件落在窗口內回一筆", () => {
    const single = { ...base, rrule: null };
    const occ = expandOccurrences(
      single,
      [],
      new Date("2026-09-15T00:00:00Z"),
      new Date("2026-09-16T00:00:00Z"),
    );
    expect(occ).toHaveLength(1);
    expect(occ[0].is_exception).toBe(false);
  });

  it("每週重複展開出 4 次（COUNT=4）", () => {
    const occ = expandOccurrences(
      base,
      [],
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(occ).toHaveLength(4);
    expect(occ.map((o) => o.occurrence_start_utc)).toEqual([
      "2026-09-15T06:00:00.000Z",
      "2026-09-22T06:00:00.000Z",
      "2026-09-29T06:00:00.000Z",
      "2026-10-06T06:00:00.000Z",
    ]);
  });

  it("exception 覆寫對應 occurrence（改期）", () => {
    const occ = expandOccurrences(
      base,
      [
        {
          id: "evt_1b",
          recurrence_id: "2026-09-22T06:00:00Z",
          start_utc: "2026-09-22T08:00:00Z",
          end_utc: "2026-09-22T09:00:00Z",
          title: "Moved",
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z"),
    );
    const moved = occ.find((o) => o.is_exception);
    expect(moved?.occurrence_start_utc).toBe("2026-09-22T08:00:00.000Z");
    expect(moved?.title).toBe("Moved");
  });

  it("exdate 排除某次（取消，REC-4）", () => {
    const occ = expandOccurrences(
      { ...base, exdate: ["2026-09-22T06:00:00Z"] },
      [],
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(occ).toHaveLength(3);
    expect(occ.some((o) => o.occurrence_start_utc === "2026-09-22T06:00:00.000Z")).toBe(false);
  });

  it("窗口外不展開", () => {
    const occ = expandOccurrences(
      base,
      [],
      new Date("2027-01-01T00:00:00Z"),
      new Date("2027-02-01T00:00:00Z"),
    );
    expect(occ).toHaveLength(0);
  });
});
