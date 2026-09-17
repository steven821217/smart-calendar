import { describe, it, expect } from "vitest";
import { parseEventFromText } from "@scal/shared";

// 固定參考時間：2026-01-05T00:00:00Z 為星期一（UTC）
const NOW = "2026-01-05T00:00:00Z";

describe("RuleBasedParser (5.4 / REQ-S3)", () => {
  it("解析『tomorrow 3pm』：明天 15:00（UTC 時區）", () => {
    const d = parseEventFromText({ text: "Lunch tomorrow 3pm", reference_now_utc: NOW, default_timezone: "UTC" });
    expect(d.start_utc).toBe("2026-01-06T15:00:00.000Z");
    expect(d.end_utc).toBe("2026-01-06T16:00:00.000Z"); // 預設 60 分
    expect(d.title.toLowerCase()).toContain("lunch");
    expect(d.rrule).toBeNull();
  });

  it("時區換算：Asia/Taipei 下午 2 點 → UTC 06:00", () => {
    const d = parseEventFromText({
      text: "會議 明天 下午2點", reference_now_utc: NOW, default_timezone: "Asia/Taipei",
    });
    // 2026-01-06 14:00 Taipei (UTC+8) = 2026-01-06 06:00Z
    expect(d.start_utc).toBe("2026-01-06T06:00:00.000Z");
    expect(d.title).toContain("會議");
  });

  it("每週重複 → 產生 RRULE FREQ=WEEKLY;BYDAY", () => {
    const d = parseEventFromText({
      text: "Standup every monday 9am", reference_now_utc: NOW, default_timezone: "UTC",
    });
    expect(d.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(d.start_utc.endsWith("09:00:00.000Z")).toBe(true);
  });

  it("時長：2 hours → end - start = 120 分", () => {
    const d = parseEventFromText({
      text: "Workshop tomorrow 10am for 2 hours", reference_now_utc: NOW, default_timezone: "UTC",
    });
    const mins = (new Date(d.end_utc).getTime() - new Date(d.start_utc).getTime()) / 60000;
    expect(mins).toBe(120);
  });

  it("缺時間 → 預設 09:00 並記 warning", () => {
    const d = parseEventFromText({ text: "Plan things", reference_now_utc: NOW, default_timezone: "UTC" });
    expect(d.start_utc.endsWith("09:00:00.000Z")).toBe(true);
    expect(d.warnings.some((w) => w.includes("time"))).toBe(true);
  });

  it("下一個週五（今天週一）→ 落在同週稍後的週五", () => {
    const d = parseEventFromText({ text: "Review friday 4pm", reference_now_utc: NOW, default_timezone: "UTC" });
    // 週一(1/5) → 週五(1/9)
    expect(d.start_utc).toBe("2026-01-09T16:00:00.000Z");
  });
});
