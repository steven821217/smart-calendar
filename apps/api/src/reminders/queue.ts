import { Queue } from "bullmq";
import IORedis from "ioredis";

export interface ReminderJobData {
  workspaceId: string;
  eventId: string;
  occurrenceStartUtc: string;
  memberId: string;
  leadMinutes: number;
}

// ESM 環境：傳已建構的 ioredis 實例（maxRetriesPerRequest: null 為 BullMQ 要求）
export const redisConnection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
});

export const remindersQueue = new Queue<ReminderJobData>("reminders", {
  connection: redisConnection,
});

/** 穩定 jobId：含 lead 維度，支援多重提醒各自重排/去重（REM-2/11）。
 *  注意 BullMQ jobId 不可含冒號，故用 '.' 分隔；時間戳的冒號改為 '-'。 */
export function reminderJobId(d: {
  eventId: string;
  occurrenceStartUtc: string;
  memberId: string;
  leadMinutes: number;
}): string {
  const occ = d.occurrenceStartUtc.replace(/:/g, "-");
  return `reminder.${d.eventId}.${occ}.${d.memberId}.${d.leadMinutes}`;
}

/**
 * 排程「會前 N 分鐘」提醒（ASYNC-1：delayed job，不輪詢 DB）。
 * runAt = occurrenceStart − leadMinutes；delay <=0（已過）則跳過或立即。
 */
export async function scheduleReminder(d: ReminderJobData): Promise<string | null> {
  const runAt = new Date(d.occurrenceStartUtc).getTime() - d.leadMinutes * 60_000;
  const delay = runAt - Date.now();
  if (delay <= 0) return null; // 已過期：本實作跳過（policy 可改為立即）
  const jobId = reminderJobId(d);
  await remindersQueue.add("event-reminder", d, {
    jobId,
    delay,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: false, // 失敗保留供 DLQ 檢視
  });
  return jobId;
}

/** 改期：移除舊 jobId、以新時間重排（REM-3）。 */
export async function rescheduleReminder(
  oldData: Omit<ReminderJobData, "workspaceId"> & { workspaceId: string },
  newOccurrenceStartUtc: string,
): Promise<string | null> {
  await cancelReminder(oldData);
  return scheduleReminder({ ...oldData, occurrenceStartUtc: newOccurrenceStartUtc });
}

/** 取消提醒（事件取消/該次 exdate，REM-3）。 */
export async function cancelReminder(d: {
  eventId: string;
  occurrenceStartUtc: string;
  memberId: string;
  leadMinutes: number;
}): Promise<void> {
  const job = await remindersQueue.getJob(reminderJobId(d));
  if (job) await job.remove();
}
