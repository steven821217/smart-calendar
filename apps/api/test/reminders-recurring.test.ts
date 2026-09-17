import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 7.4 重複事件近期窗口補排 —— 純邏輯測試。
 *
 * 對齊既有 mock 風格：不打真實 redis / db。這裡以 vi.mock 取代兩個依賴：
 *  - ./queue.js：scheduleReminder 用一個「重現真實語意」的假實作
 *    （delay<=0 回 null 跳過、否則回穩定 jobId），並記錄呼叫，供斷言排了幾個 job。
 *  - ../db/pool.js：withWorkspace 直接以一個回傳 canned rows 的 fake client 執行 callback，
 *    避免連線 Postgres。
 *
 * 覆蓋：(a) 窗口內多個 occurrence 各自排 job 且 jobId 去重、(b) 過期 occurrence 不排、
 * (c) 窗口外 occurrence 不排。
 */

// --- stub ./queue.js（不載入真實 BullMQ/ioredis）---
vi.mock("../src/reminders/queue.js", () => {
  function reminderJobId(d: {
    eventId: string;
    occurrenceStartUtc: string;
    memberId: string;
    leadMinutes: number;
  }): string {
    const occ = d.occurrenceStartUtc.replace(/:/g, "-");
    return `reminder.${d.eventId}.${occ}.${d.memberId}.${d.leadMinutes}`;
  }
  // 重現真實 scheduleReminder：delay<=0 跳過（回 null），否則回穩定 jobId。
  const scheduleReminder = vi.fn(
    async (d: {
      workspaceId: string;
      eventId: string;
      occurrenceStartUtc: string;
      memberId: string;
      leadMinutes: number;
    }): Promise<string | null> => {
      const runAt = new Date(d.occurrenceStartUtc).getTime() - d.leadMinutes * 60_000;
      if (runAt - Date.now() <= 0) return null;
      return reminderJobId(d);
    },
  );
  return {
    reminderJobId,
    scheduleReminder,
    cancelReminder: vi.fn(),
    redisConnection: {},
    remindersQueue: {},
  };
});

// --- stub ../db/pool.js（不連 Postgres）：withWorkspace 餵 canned rows ---
type Row = Record<string, unknown>;
let masterRows: Row[] = [];
let reminderRows: Row[] = [];
let exceptionRows: Row[] = [];

vi.mock("../src/db/pool.js", () => {
  const fakeClient = {
    query: async (sql: string) => {
      const s = sql.replace(/\s+/g, " ");
      if (s.includes("FROM events") && s.includes("recurrence_id IS NULL")) {
        return { rows: masterRows };
      }
      if (s.includes("FROM event_reminders")) {
        return { rows: reminderRows };
      }
      if (s.includes("master_id = $1")) {
        return { rows: exceptionRows };
      }
      return { rows: [] };
    },
  };
  return {
    withWorkspace: async (_ws: string | null, fn: (c: typeof fakeClient) => Promise<unknown>) =>
      fn(fakeClient),
    pool: {},
  };
});

import { rescheduleRecurringWindow } from "../src/reminders/recurring.js";
import { scheduleReminder } from "../src/reminders/queue.js";

const NOW = new Date("2026-09-15T00:00:00Z");
const WS = "ws-1";
const EVENT = "evt-1";

/** 每週二 06:00 的重複事件（無 COUNT，靠窗口收斂）。 */
function weeklyMaster(): Row {
  return {
    id: EVENT,
    title: "Weekly sync",
    start_utc: new Date("2026-09-15T06:00:00Z"),
    end_utc: new Date("2026-09-15T06:30:00Z"),
    timezone: "Asia/Taipei",
    rrule: "FREQ=WEEKLY;BYDAY=TU",
    rdate: [],
    exdate: [],
    source: "app",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 把系統時鐘釘在 NOW：stub 的 scheduleReminder 用 Date.now() 判斷 delay<=0，
  // 必須與注入窗口的 now 一致，測試才具決定性（不隨真實時間漂移）。
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  masterRows = [];
  reminderRows = [];
  exceptionRows = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rescheduleRecurringWindow — 近期窗口補排 (7.4)", () => {
  it("(a) 窗口內多個 occurrence 各自排 job，jobId 去重（30 天內每週二 = 5 次）", async () => {
    masterRows = [weeklyMaster()];
    reminderRows = [{ member_id: "m1", lead_minutes: 10 }];

    // 窗口 [2026-09-15, 2026-10-15)：週二 = 09-15, 09-22, 09-29, 10-06, 10-13 → 5 次
    const ids = await rescheduleRecurringWindow(WS, EVENT, { horizonDays: 30, now: NOW });

    expect(ids).toHaveLength(5);
    // 全部唯一（穩定 jobId 天然去重）
    expect(new Set(ids).size).toBe(5);
    // 皆為此事件 + member + lead 維度
    for (const id of ids) {
      expect(id).toMatch(/^reminder\.evt-1\..*\.m1\.10$/);
    }
    // scheduleReminder 對每個 occurrence 呼叫一次
    expect(scheduleReminder).toHaveBeenCalledTimes(5);
  });

  it("(a2) 多個訂閱 member × 多 occurrence：job 數 = occurrences × reminders，且互不重複", async () => {
    masterRows = [weeklyMaster()];
    reminderRows = [
      { member_id: "m1", lead_minutes: 10 },
      { member_id: "m2", lead_minutes: 30 },
    ];

    const ids = await rescheduleRecurringWindow(WS, EVENT, { horizonDays: 30, now: NOW });

    expect(ids).toHaveLength(10); // 5 occurrences × 2 reminders
    expect(new Set(ids).size).toBe(10);
    expect(ids.filter((i) => i.endsWith(".m1.10"))).toHaveLength(5);
    expect(ids.filter((i) => i.endsWith(".m2.30"))).toHaveLength(5);
  });

  it("(b) 過期 occurrence（delay<=0）不排：now 之後才起算，過去的那次被跳過", async () => {
    // master 從「上週二」就開始重複，但窗口 now=2026-09-15 起算。
    const m = weeklyMaster();
    m.start_utc = new Date("2026-09-08T06:00:00Z"); // 上週二（早於 now）
    m.rrule = "FREQ=WEEKLY;BYDAY=TU";
    masterRows = [m];
    reminderRows = [{ member_id: "m1", lead_minutes: 10 }];

    // 窗口 windowStart = now = 09-15T00:00Z，故 09-08 那次在窗口外不會展開；
    // 09-15T06:00Z 距 now 有 6 小時 > lead 10 分鐘，仍會排。
    const ids = await rescheduleRecurringWindow(WS, EVENT, { horizonDays: 30, now: NOW });

    // 不含 09-08（過期/窗口外），第一筆為 09-15
    expect(ids.some((i) => i.includes("2026-09-08"))).toBe(false);
    expect(ids[0]).toContain("2026-09-15T06-00-00");
  });

  it("(b2) 第一個 occurrence 恰好已過提前量 → 該次被跳過（scheduleReminder 回 null）", async () => {
    const m = weeklyMaster();
    masterRows = [m];
    // lead 過大：09-15T06:00Z 減 100 小時 < now(09-15T00:00Z) → delay<=0 跳過首次
    reminderRows = [{ member_id: "m1", lead_minutes: 100 * 60 }];

    const ids = await rescheduleRecurringWindow(WS, EVENT, { horizonDays: 30, now: NOW });

    // 首次 09-15 被跳過，其餘 4 次（09-22..10-13）仍排
    expect(ids.some((i) => i.includes("2026-09-15T06-00-00"))).toBe(false);
    expect(ids).toHaveLength(4);
  });

  it("(c) 窗口外 occurrence 不排：horizon 只有 7 天 → 僅 1 次（09-15）", async () => {
    masterRows = [weeklyMaster()];
    reminderRows = [{ member_id: "m1", lead_minutes: 10 }];

    const ids = await rescheduleRecurringWindow(WS, EVENT, { horizonDays: 7, now: NOW });

    expect(ids).toHaveLength(1);
    expect(ids[0]).toContain("2026-09-15T06-00-00");
  });

  it("非重複事件（無 rrule）不在此路徑排程，回空", async () => {
    const m = weeklyMaster();
    m.rrule = null;
    masterRows = [m];
    reminderRows = [{ member_id: "m1", lead_minutes: 10 }];

    const ids = await rescheduleRecurringWindow(WS, EVENT, { horizonDays: 30, now: NOW });
    expect(ids).toEqual([]);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it("無啟用中 reminder → 不排任何 job", async () => {
    masterRows = [weeklyMaster()];
    reminderRows = [];
    const ids = await rescheduleRecurringWindow(WS, EVENT, { horizonDays: 30, now: NOW });
    expect(ids).toEqual([]);
  });
});
