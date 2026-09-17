import type { PoolClient } from "pg";
import { withWorkspace } from "../db/pool.js";
import { signRsvpToken } from "../agents/option_token.js";

/**
 * RSVP Service（feature-team-groups Req 3.2）。
 * Member 對「幫他排的 pending 事件」回覆 accept / decline。
 * accept → 事件正式排入行事曆（event_participants.rsvp_status='accepted'）；
 * decline → rsvp_status='declined'。
 * 所有 SQL 走 withWorkspace（RLS 兜底）；workspace 來自 rsvp_token 的 claims（後端簽章不可竄改）。
 */

export type RsvpDecision = "accept" | "decline";

export class RsvpError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg);
    this.name = "RsvpError";
  }
}

export interface RsvpResult {
  event_id: string;
  member_id: string;
  rsvp_status: "accepted" | "declined";
  event?: {
    title: string;
    start_utc: string;
    end_utc: string;
    timezone: string;
    location: string | null;
  };
}

/**
 * 套用 RSVP 回覆到 event_participants。找不到該 (event, member) 參與者列 → RsvpError('not_found')。
 */
export async function applyRsvp(
  workspaceId: string,
  eventId: string,
  memberId: string,
  decision: RsvpDecision,
): Promise<RsvpResult> {
  const status = decision === "accept" ? "accepted" : "declined";
  return withWorkspace(workspaceId, async (c: PoolClient) => {
    const r = await c.query(
      `UPDATE event_participants
          SET rsvp_status = $3
        WHERE workspace_id = $4 AND event_id = $1 AND member_id = $2
        RETURNING event_id, member_id, rsvp_status`,
      [eventId, memberId, status, workspaceId],
    );
    if (r.rows.length === 0) {
      throw new RsvpError("not_found", "no matching pending invitation for this member");
    }
    // 附上事件細節，讓 Member 回覆頁能顯示「排在何時何地」（best-effort）。
    const ev = await c.query(
      `SELECT title, start_utc, end_utc, timezone, location FROM events WHERE id = $1 AND deleted_at IS NULL`,
      [eventId],
    );
    const row = r.rows[0] as RsvpResult;
    if (ev.rows[0]) {
      const e = ev.rows[0];
      row.event = {
        title: e.title,
        start_utc: new Date(e.start_utc).toISOString(),
        end_utc: new Date(e.end_utc).toISOString(),
        timezone: e.timezone,
        location: e.location ?? null,
      };
    }
    return row;
  });
}

/** 讀單一參與者的 RSVP 狀態（供 UI / 測試核對）。 */
export async function getRsvpStatus(
  workspaceId: string,
  eventId: string,
  memberId: string,
): Promise<string | null> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT rsvp_status FROM event_participants WHERE event_id=$1 AND member_id=$2`,
      [eventId, memberId],
    );
    return r.rows[0]?.rsvp_status ?? null;
  });
}

export interface PendingInvitation {
  event_id: string;
  title: string;
  start_utc: string;
  end_utc: string;
  timezone: string;
  location: string | null;
  // 該 member 專屬的一鍵回覆 token（供 App 內通知直接深連結至 RSVP 頁）。
  // 呼叫者已以本人登入 JWT 通過認證（sub=member membership_id），為「自己」簽發
  // 綁 workspace/event/member 的 rsvp_token 非權限擴張（與委員會落實時簽發的同型 token）。
  rsvp_token: string;
}

/**
 * 列出某 member 待回覆（pending）的邀請 + 事件細節。
 * 供登入使用者的「待處理」收件匣：agent 幫他排的、尚未 accept 的會議。
 */
export async function listPendingForMember(
  workspaceId: string,
  memberId: string,
): Promise<PendingInvitation[]> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT e.id AS event_id, e.title, e.start_utc, e.end_utc, e.timezone, e.location
         FROM event_participants ep
         JOIN events e ON e.id = ep.event_id AND e.deleted_at IS NULL
        WHERE ep.member_id = $1 AND ep.rsvp_status = 'pending'
        ORDER BY e.start_utc`,
      [memberId],
    );
    return r.rows.map((row) => ({
      event_id: row.event_id,
      title: row.title,
      start_utc: new Date(row.start_utc).toISOString(),
      end_utc: new Date(row.end_utc).toISOString(),
      timezone: row.timezone,
      location: row.location ?? null,
      rsvp_token: signRsvpToken({
        kind: "rsvp",
        workspace: workspaceId,
        event_id: row.event_id,
        member_id: memberId,
      }),
    }));
  });
}
