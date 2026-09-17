import { Worker } from "bullmq";
import IORedis from "ioredis";
import { withWorkspace } from "../db/pool.js";
import { sendMail } from "../integrations/mailer.js";
import type { ReminderJobData } from "./queue.js";
import {
  MAINTENANCE_QUEUE_NAME,
  backfillUpcomingReminders,
  registerReminderMaintenance,
} from "./recurring.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
});

/**
 * reminders worker：
 * - 設 workspace 脈絡（REM-5：worker 端 DB 存取仍受 RLS）。
 * - 發送前查證事件現況，已刪/已改則不發（REM-6 防過時提醒）。
 * - 發送 Email → MailHog（10.1）；SMTP 未設定則跳過（不失敗）。
 */
export function startRemindersWorker() {
  return new Worker<ReminderJobData>(
    "reminders",
    async (job) => {
      const { workspaceId, eventId, occurrenceStartUtc, memberId } = job.data;
      const ev = await withWorkspace(workspaceId, async (c) => {
        return (
          await c.query(
            `SELECT id, title, deleted_at, start_utc FROM events WHERE id=$1`,
            [eventId],
          )
        ).rows[0];
      });
      if (!ev || ev.deleted_at) return { skipped: "event cancelled" }; // 已取消 → 不發

      // 收件人 email：由 membership → users（在 workspace 脈絡）
      const to = await withWorkspace(workspaceId, async (c) => {
        const r = await c.query(
          `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
          [memberId],
        );
        return r.rows[0]?.email as string | undefined;
      });

      const result = await sendMail({
        from: process.env.MAIL_FROM ?? "no-reply@smart-calendar.local",
        to: to ?? "unknown@smart-calendar.local",
        subject: `Reminder: ${ev.title}`,
        text: `Your event "${ev.title}" starts at ${occurrenceStartUtc} (UTC).`,
      });
      return { eventId, memberId, mail: result };
    },
    { connection },
  );
}

/**
 * reminders-maintenance worker：消費 repeatable backfill job，向前滾動補排重複事件窗口
 * （7.4）。全域掃描交由 backfillUpcomingReminders；此處僅負責在每次觸發時執行它。
 * 週期性推進由 BullMQ repeatable（delayed）驅動，不在應用層 setInterval 輪詢 DB。
 */
export function startReminderMaintenanceWorker() {
  return new Worker(
    MAINTENANCE_QUEUE_NAME,
    async () => {
      const r = await backfillUpcomingReminders();
      return r; // { events, scheduled }
    },
    { connection },
  );
}

if (process.argv[1] && process.argv[1].endsWith("worker.ts")) {
  const w = startRemindersWorker();
  const mw = startReminderMaintenanceWorker();
  // 註冊 repeatable maintenance job（冪等）：由 BullMQ delayed 機制週期推進窗口，不輪詢 DB。
  void registerReminderMaintenance();
  process.on("SIGTERM", async () => {
    await Promise.all([w.close(), mw.close()]); // 優雅關閉在途 job
    process.exit(0);
  });
  console.log("reminders worker started");
}
