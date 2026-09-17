import type { PoolClient } from "pg";
import { withWorkspace } from "../db/pool.js";
import { scheduleReminder, cancelReminder } from "./queue.js";
import { rescheduleRecurringWindow } from "./recurring.js";

export interface CreateReminderArgs {
  lead_minutes: number;
  member_id?: string | null;
  channel?: "email" | "push" | "webhook";
}

/** 列某事件的提醒（event.read）。 */
export async function listReminders(workspaceId: string, eventId: string) {
  return withWorkspace(workspaceId, async (c: PoolClient) => {
    const r = await c.query(
      `SELECT id, event_id, member_id, lead_minutes, channel, enabled, created_at
         FROM event_reminders
        WHERE event_id = $1
        ORDER BY lead_minutes`,
      [eventId],
    );
    return r.rows;
  });
}

/**
 * 建立提醒（event.update）。寫入 event_reminders 後，若事件為單次且時間在未來，
 * 立即排一個 delayed job（ASYNC-1：不輪詢 DB）。重複事件近期窗口補排延後（7.4）。
 * 回傳 { reminder, scheduled } — scheduled 為 job id 或 null（已過期/重複事件）。
 * 事件不存在（含跨 workspace，RLS 過濾）回 null → 路由層 404。
 */
export async function createReminder(
  workspaceId: string,
  eventId: string,
  args: CreateReminderArgs,
) {
  const result = await withWorkspace(workspaceId, async (c: PoolClient) => {
    const ev = (
      await c.query(
        `SELECT id, start_utc, rrule FROM events WHERE id = $1 AND deleted_at IS NULL`,
        [eventId],
      )
    ).rows[0];
    if (!ev) return null;

    const channel = args.channel ?? "email";
    const inserted = (
      await c.query(
        `INSERT INTO event_reminders(workspace_id, event_id, member_id, lead_minutes, channel)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (event_id, member_id, lead_minutes, channel)
         DO UPDATE SET enabled = true
         RETURNING id, event_id, member_id, lead_minutes, channel, enabled, created_at`,
        [workspaceId, eventId, args.member_id ?? null, args.lead_minutes, channel],
      )
    ).rows[0];

    // 單次事件：立即排一個 delayed job。重複事件的補排在交易 commit 後進行（7.4），
    // 否則另開交易的 rescheduleRecurringWindow 讀不到尚未 commit 的 reminder 列。
    let scheduled: string | null = null;
    if (!ev.rrule && args.member_id) {
      scheduled = await scheduleReminder({
        workspaceId,
        eventId,
        occurrenceStartUtc: new Date(ev.start_utc).toISOString(),
        memberId: args.member_id,
        leadMinutes: args.lead_minutes,
      });
    }
    return { reminder: inserted, scheduled, isRecurring: Boolean(ev.rrule) };
  });

  if (!result) return null;

  // 重複事件：交易已 commit，觸發近期窗口補排（7.4）。展開 REMINDER_HORIZON_DAYS 天內
  // 每個 occurrence，各自為訂閱 member 排 delayed job（穩定 jobId 去重、過期 occurrence 跳過）。
  if (result.isRecurring) {
    await rescheduleRecurringWindow(workspaceId, eventId);
  }
  const { reminder, scheduled } = result;
  return { reminder, scheduled };
}

/**
 * 移除提醒（event.update）。刪 event_reminders 列並取消對應 delayed job。
 * 無此列（含跨 workspace）回 false → 路由層 404。
 */
export async function deleteReminder(
  workspaceId: string,
  eventId: string,
  reminderId: string,
): Promise<boolean> {
  return withWorkspace(workspaceId, async (c: PoolClient) => {
    const row = (
      await c.query(
        `SELECT r.id, r.member_id, r.lead_minutes, e.start_utc, e.rrule
           FROM event_reminders r
           JOIN events e ON e.id = r.event_id
          WHERE r.id = $1 AND r.event_id = $2`,
        [reminderId, eventId],
      )
    ).rows[0];
    if (!row) return false;

    await c.query(`DELETE FROM event_reminders WHERE id = $1`, [reminderId]);

    // 取消對應的 delayed job（若為單次事件且有 member）。
    if (!row.rrule && row.member_id) {
      await cancelReminder({
        eventId,
        occurrenceStartUtc: new Date(row.start_utc).toISOString(),
        memberId: row.member_id,
        leadMinutes: row.lead_minutes,
      });
    }
    return true;
  });
}
