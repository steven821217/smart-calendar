import { describe, expect, it } from "vitest";
import { parseEventFromText } from "@scal/shared";

/**
 * 時段詞必須套用到 12 小時制的時鐘讀數。
 * 實測使用者說「今天晚上9:00打球」被排成早上 09:00——HH:MM 分支完全忽略了「晚上」。
 */
const NOW = "2026-09-22T02:00:00.000Z"; // 台北 10:00
const p = (text: string) => parseEventFromText({ text, reference_now_utc: NOW, default_timezone: "Asia/Taipei" });
const tpeHour = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600_000).getUTCHours();

describe("時段詞 + 時鐘讀數", () => {
  it("晚上9:00 → 21 點（半形與全形冒號都要對）", () => {
    expect(tpeHour(p("幫我安排今天晚上9:00打球").start_utc)).toBe(21);
    expect(tpeHour(p("幫我安排今天晚上9：00打球").start_utc)).toBe(21);
  });

  it("晚上8:00 → 20 點；下午2:30 → 14 點", () => {
    expect(tpeHour(p("今天晚上8:00去見客戶").start_utc)).toBe(20);
    expect(tpeHour(p("明天下午2:30開會").start_utc)).toBe(14);
  });

  it("上午、24 小時制與「點」格式不受影響", () => {
    expect(tpeHour(p("明天上午9:00開會").start_utc)).toBe(9);
    expect(tpeHour(p("明天 14:00 開會").start_utc)).toBe(14);
    expect(tpeHour(p("明天晚上9點打球").start_utc)).toBe(21);
  });
});
