import pg from "pg";
import type { PoolClient } from "pg";
import { Queue } from "bullmq";
import { withWorkspace } from "../db/pool.js";
import { expandOccurrences, type ExceptionEvent } from "../events/recurrence.js";
import { scheduleReminder, redisConnection } from "./queue.js";

/**
 * 重複事件近期窗口補排（7.4）。
 *
 * 系統原則（7.7）：不輪詢 DB。單次事件在 createReminder 時就排好 delayed job；
 * 重複事件（有 rrule）無法一次排「無限多」次 occurrence，故採「近期窗口」策略：
 * 只展開未來 REMINDER_HORIZON_DAYS 天內的每個 occurrence，各自為每個訂閱的 member
 * 排一個 delayed job。窗口靠 BullMQ repeatable maintenance job 週期性向前滾動推進，
 * 而非用 setInterval 掃 DB（見 startReminderMaintenance）。
 *
 * 去重天然由 scheduleReminder 的穩定 jobId（reminder.<eventId>.<occ>.<memberId>.<lead>）
 * 保證——同一 occurrence 重複補排只會覆寫同一 jobId，不會產生重複提醒。
 * 過時提醒的最終防線仍在 worker：發送前查證事件現況（deleted 則跳過），此處不繞過。
 */

/** 窗口天數（預設 30）。 */
export function reminderHorizonDays(): number {
  const n = Number(process.env.REMINDER_HORIZON_DAYS ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** maintenance 推進間隔（毫秒，預設 1 天）。 */
export function reminderMaintenanceEveryMs(): number {
  const n = Number(process.env.REMINDER_MAINTENANCE_EVERY_MS ?? 24 * 60 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60 * 1000;
}

/** admin 連線（RLS bypass）：僅供跨 workspace 掃描 master 清單用（比照 auth/routes.ts）。 */
function adminPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

/** event_reminders 一列（補排所需欄位）。 */
interface ReminderRow {
  member_id: string | null;
  lead_minutes: number;
}

/**
 * 對「單一重複事件」補排近期窗口（rescheduleRecurringWindow）。
 * 在 workspace 脈絡內：撈 master + exceptions + 已啟用的 reminders，展開窗口內 occurrence，
 * 對每個 (occurrence × reminder) 呼叫 scheduleReminder（穩定 jobId 去重、delay<=0 自動跳過）。
 * 回傳實際排定的 job id 陣列（不含被跳過/去重掉的）。
 * 事件不存在、非重複事件、或無啟用中 reminder 時回空陣列。
 */
export async function rescheduleRecurringWindow(
  workspaceId: string,
  eventId: string,
  opts?: { horizonDays?: number; now?: Date },
): Promise<string[]> {
  const horizonDays = opts?.horizonDays ?? reminderHorizonDays();
  const now = opts?.now ?? new Date();
  const windowStart = now;
  const windowEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  return withWorkspace(workspaceId, async (c: PoolClient) => {
    const m = (
      await c.query(
        `SELECT id, title, start_utc, end_utc, timezone, rrule, rdate, exdate, source
           FROM events
          WHERE id = $1 AND deleted_at IS NULL AND recurrence_id IS NULL`,
        [eventId],
      )
    ).rows[0];
    // 非重複事件（無 rrule）由 createReminder 單次排程處理，此處只管重複事件。
    if (!m || !m.rrule) return [];

    // 已啟用、且綁定 member 的提醒才可排 job（member_id 為 null 者無收件對象）。
    const reminders: ReminderRow[] = (
      await c.query(
        `SELECT member_id, lead_minutes
           FROM event_reminders
          WHERE event_id = $1 AND enabled = true AND member_id IS NOT NULL`,
        [eventId],
      )
    ).rows;
    if (reminders.length === 0) return [];

    // 撈該 master 的 exceptions（覆寫對應 occurrence 的時間/標題）。
    const exceptions: ExceptionEvent[] = (
      await c.query(`SELECT * FROM events WHERE master_id = $1 AND deleted_at IS NULL`, [m.id])
    ).rows.map((e) => ({
      id: e.id,
      recurrence_id: new Date(e.recurrence_id).toISOString(),
      start_utc: new Date(e.start_utc).toISOString(),
      end_utc: new Date(e.end_utc).toISOString(),
      title: e.title,
    }));

    const occurrences = expandOccurrences(
      {
        id: m.id,
        title: m.title,
        start_utc: new Date(m.start_utc).toISOString(),
        end_utc: new Date(m.end_utc).toISOString(),
        timezone: m.timezone,
        rrule: m.rrule,
        rdate: (m.rdate ?? []).map((d: Date) => new Date(d).toISOString()),
        exdate: (m.exdate ?? []).map((d: Date) => new Date(d).toISOString()),
        source: m.source,
      },
      exceptions,
      windowStart,
      windowEnd,
    );

    const scheduled: string[] = [];
    for (const occ of occurrences) {
      for (const r of reminders) {
        // scheduleReminder：delay<=0（過期 occurrence）回 null 自動跳過；
        // 穩定 jobId 使重複補排天然去重（同一 job 覆寫，不重排）。
        const id = await scheduleReminder({
          workspaceId,
          eventId,
          occurrenceStartUtc: occ.occurrence_start_utc,
          memberId: r.member_id as string,
          leadMinutes: r.lead_minutes,
        });
        if (id) scheduled.push(id);
      }
    }
    return scheduled;
  });
}

/**
 * 全域滾動補排（backfillUpcomingReminders）。
 * 掃描所有仍有 rrule 的 master 事件，對每個呼叫 rescheduleRecurringWindow 推進其窗口。
 * 供 maintenance repeatable job 週期性驅動（見 startReminderMaintenance），
 * 亦可手動觸發。回傳處理的事件數。
 */
export async function backfillUpcomingReminders(opts?: {
  horizonDays?: number;
  now?: Date;
}): Promise<{ events: number; scheduled: number }> {
  const admin = adminPool();
  try {
    // 跨 workspace 撈出「有 rrule 且尚有啟用中提醒」的 master 清單（RLS bypass 只讀 id）。
    const rows = (
      await admin.query(
        `SELECT DISTINCT e.workspace_id, e.id
           FROM events e
           JOIN event_reminders r ON r.event_id = e.id AND r.enabled = true
          WHERE e.rrule IS NOT NULL AND e.deleted_at IS NULL AND e.recurrence_id IS NULL`,
      )
    ).rows as Array<{ workspace_id: string; id: string }>;

    let scheduled = 0;
    for (const row of rows) {
      const ids = await rescheduleRecurringWindow(row.workspace_id, row.id, opts);
      scheduled += ids.length;
    }
    return { events: rows.length, scheduled };
  } finally {
    await admin.end();
  }
}

// --- maintenance queue：以 BullMQ repeatable job 推進窗口（不用 setInterval 輪詢）---

export const MAINTENANCE_QUEUE_NAME = "reminders-maintenance";
export const MAINTENANCE_JOB_NAME = "backfill-window";

// 延遲建構：僅在真正註冊 maintenance 時才開 Redis 連線，避免 import 就觸發連線
// （純邏輯測試 stub 掉 queue.js 後不應嘗試連 redis）。
let _maintenanceQueue: Queue | null = null;
export function getMaintenanceQueue(): Queue {
  if (!_maintenanceQueue) {
    _maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redisConnection });
  }
  return _maintenanceQueue;
}

/**
 * 註冊 maintenance job scheduler：每 REMINDER_MAINTENANCE_EVERY_MS 產生一次 backfill job。
 * upsertJobScheduler 以 schedulerId 冪等（重複註冊只會更新、不疊加）。實際執行由 worker 端
 * 消費此佇列。這是「事件驅動的週期推進」——BullMQ 內部以 delayed job 排下一次，而非應用層輪詢 DB。
 */
export async function registerReminderMaintenance(): Promise<void> {
  await getMaintenanceQueue().upsertJobScheduler(
    MAINTENANCE_JOB_NAME,
    { every: reminderMaintenanceEveryMs() },
    { name: MAINTENANCE_JOB_NAME, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
}
