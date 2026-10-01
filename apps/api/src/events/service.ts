import type { PoolClient } from "pg";
import { withWorkspace } from "../db/pool.js";
import { expandOccurrences, type Occurrence } from "./recurrence.js";

export interface CreateEventArgs {
  calendar_id: string;
  title: string;
  description?: string | null;
  start_utc: string;
  end_utc: string;
  timezone: string;
  rrule?: string | null;
  rdate?: string[];
  exdate?: string[];
  visibility?: string;
  location?: string | null;
  created_by: string;
  source?: string;
}

/** 建立事件（單次或 master）。所有 SQL 在 workspace 脈絡交易內（RLS 兜底）。 */
export async function createEvent(workspaceId: string, args: CreateEventArgs) {
  return withWorkspace(workspaceId, async (c: PoolClient) => {
    const r = await c.query(
      `INSERT INTO events(workspace_id,calendar_id,title,description,start_utc,end_utc,
         timezone,rrule,rdate,exdate,visibility,location,created_by,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        workspaceId,
        args.calendar_id,
        args.title,
        args.description ?? null,
        args.start_utc,
        args.end_utc,
        args.timezone,
        args.rrule ?? null,
        args.rdate ?? null,
        args.exdate ?? null,
        args.visibility ?? "busy",
        args.location ?? null,
        args.created_by,
        args.source ?? "app",
      ],
    );
    return r.rows[0];
  });
}

/** 取單筆（不展開）。 */
export async function getEvent(workspaceId: string, id: string) {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(`SELECT * FROM events WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return r.rows[0] ?? null;
  });
}

/** 邀請的 email 對不到本工作區成員：由路由層轉成 422 並附上是哪些 email。 */
export class UnknownParticipantEmailError extends Error {
  constructor(public readonly emails: string[]) {
    super(
      `這些 email 不在本工作區的成員名單中：${emails.join("、")}。` +
        "請先到「團隊群組」頁把他們加入工作區（對方需已用該 email 註冊）。",
    );
    this.name = "UnknownParticipantEmailError";
  }
}

export interface EventParticipant {
  member_id: string | null;
  guest_email: string | null;
  display_name: string | null;
  email: string | null;
  /** pending=已邀請待回覆、accepted=已接受、declined=已婉拒 */
  rsvp_status: string;
  is_organizer: boolean;
}

/**
 * 某事件的與會者名單（含回覆狀態）。
 *
 * 先前沒有任何讀取端點會回傳與會者，所以站內看不到「這場會有誰參加」——
 * 只有 agent 路徑內部用得到。這裡補上供事件詳情顯示。
 */
export async function listEventParticipants(
  workspaceId: string,
  eventId: string,
): Promise<EventParticipant[]> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT ep.member_id, ep.guest_email, ep.rsvp_status, ep.is_organizer,
              u.display_name, u.email
         FROM event_participants ep
         LEFT JOIN memberships m ON m.id = ep.member_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE ep.event_id = $1
        ORDER BY ep.is_organizer DESC, u.display_name NULLS LAST, ep.guest_email`,
      [eventId],
    );
    return r.rows.map((x) => ({
      member_id: x.member_id ?? null,
      guest_email: x.guest_email ?? null,
      display_name: x.display_name ?? null,
      email: x.email ?? null,
      rsvp_status: x.rsvp_status,
      is_organizer: x.is_organizer,
    }));
  });
}

/**
 * 取代某事件的與會者名單。
 *
 * 語意（與 agent 排程路徑一致，見 agents/service.ts）：
 *  - 發起人（事件建立者）一律 is_organizer + accepted，且不可被移除。
 *  - 其他被邀請的人為 pending——尚未同意就不算排入他的行程，他會在待回覆清單看到。
 *  - 已經回覆過（accepted/declined）的人保留原狀態，不因為別人被加入而被重設。
 */
export async function replaceEventParticipants(
  workspaceId: string,
  eventId: string,
  organizerMembershipId: string,
  inputMemberIds: string[],
  inputGuestEmails: string[] = [],
): Promise<EventParticipant[]> {
  // 注意：withWorkspace 本身就在一個交易內，並以 set_config(..., true)（LOCAL）設定
  // RLS 的 workspace 脈絡——隨交易結束失效。因此**不可**在這裡再 BEGIN/COMMIT，
  // 否則會把外層交易提交掉、workspace 設定消失，之後的查詢全被 RLS 過濾成空。
  // 原子性由 withWorkspace 的交易保證：拋錯即整筆 ROLLBACK。
  return withWorkspace(workspaceId, async (c) => {
    {
      // email 先對到工作區成員：用 email 邀請同事時，應連到他的**成員身分**而不是
      // 當成外部訪客——否則他不會收到站內待回覆邀請，站內也看不到這場會。
      // 比對放在後端，前端就不需要（也拿不到）全體成員的 email 清單。
      let memberIds = inputMemberIds;
      let guestEmails = inputGuestEmails;
      const normalisedEmails = [...new Set(guestEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
      let resolvedMemberIds: string[] = [];
      let remainingGuestEmails = normalisedEmails;
      if (normalisedEmails.length > 0) {
        const hit = await c.query(
          `SELECT m.id AS membership_id, lower(u.email) AS email
             FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.status = 'active' AND lower(u.email) = ANY($1::text[])`,
          [normalisedEmails],
        );
        resolvedMemberIds = hit.rows.map((r) => r.membership_id as string);
        const matched = new Set(hit.rows.map((r) => r.email as string));
        remainingGuestEmails = normalisedEmails.filter((e) => !matched.has(e));
      }
      // 平台上的人一律以 email 註冊，所以「對不到成員」代表打錯字或對方還沒加入工作區。
      // 這種情況下建立一筆 guest 列毫無意義——對方沒有站內帳號、看不到待回覆清單，
      // 又沒有寄信通知，等於安靜地什麼都沒發生。因此明確報錯讓呼叫端知道。
      if (remainingGuestEmails.length > 0) {
        throw new UnknownParticipantEmailError(remainingGuestEmails);
      }
      memberIds = [...new Set([...memberIds, ...resolvedMemberIds])];
      guestEmails = remainingGuestEmails;

      const keepMembers = [...new Set([organizerMembershipId, ...memberIds])];
      // 刪掉不在新名單內的（發起人永遠留著）
      await c.query(
        `DELETE FROM event_participants
          WHERE event_id = $1
            AND is_organizer = false
            AND (member_id IS NULL OR member_id <> ALL($2::uuid[]))
            AND (guest_email IS NULL OR guest_email <> ALL($3::citext[]))`,
        [eventId, keepMembers, guestEmails],
      );
      await c.query(
        `INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status,is_organizer)
         VALUES($1,$2,$3,'accepted',true)
         ON CONFLICT (event_id, member_id)
         DO UPDATE SET is_organizer = true, rsvp_status = 'accepted'`,
        [workspaceId, eventId, organizerMembershipId],
      );
      for (const memberId of memberIds) {
        if (memberId === organizerMembershipId) continue;
        // 已回覆過的不重設，否則每次編輯事件都會把對方的同意狀態清掉
        await c.query(
          `INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status)
           VALUES($1,$2,$3,'pending')
           ON CONFLICT (event_id, member_id) DO NOTHING`,
          [workspaceId, eventId, memberId],
        );
      }
      for (const email of guestEmails) {
        // (event_id, guest_email) 沒有唯一約束（唯一索引只在 (event_id, member_id) 上，
        // 且 member_id 為 NULL 時 Postgres 視為互不相同），所以必須自己防重複。
        // guest_email 欄位是 citext（本身不分大小寫），因此直接比較即可——
        // 額外包 lower() 會讓同一個參數被同時推導成 text 與 citext（42P08）。
        await c.query(
          `INSERT INTO event_participants(workspace_id,event_id,guest_email,rsvp_status)
           SELECT $1,$2,$3::citext,'pending'
            WHERE NOT EXISTS (
              SELECT 1 FROM event_participants
               WHERE event_id = $2 AND guest_email = $3::citext
            )`,
          [workspaceId, eventId, email],
        );
      }
    }
    const r = await c.query(
      `SELECT ep.member_id, ep.guest_email, ep.rsvp_status, ep.is_organizer, u.display_name, u.email
         FROM event_participants ep
         LEFT JOIN memberships m ON m.id = ep.member_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE ep.event_id = $1
        ORDER BY ep.is_organizer DESC, u.display_name NULLS LAST, ep.guest_email`,
      [eventId],
    );
    return r.rows.map((x) => ({
      member_id: x.member_id ?? null,
      guest_email: x.guest_email ?? null,
      display_name: x.display_name ?? null,
      email: x.email ?? null,
      rsvp_status: x.rsvp_status,
      is_organizer: x.is_organizer,
    }));
  });
}

export type Scope = "this" | "this_and_future" | "all";

/**
 * 依 RFC 5545 scope 更新（EV-3）：
 * - this：建 exception 列（recurrence_id + master_id），不動 master。
 * - this_and_future：master rrule 加 UNTIL 截斷於該次之前。
 * - all：直接改 master。
 */
export async function updateEvent(
  workspaceId: string,
  id: string,
  scope: Scope,
  patch: Partial<CreateEventArgs> & { occurrence_start_utc?: string },
) {
  return withWorkspace(workspaceId, async (c) => {
    const master = (await c.query(`SELECT * FROM events WHERE id=$1`, [id])).rows[0];
    if (!master) return null;

    if (scope === "this") {
      if (!patch.occurrence_start_utc) throw new Error("occurrence_start_utc required for scope=this");
      const r = await c.query(
        `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,
           recurrence_id,master_id,visibility,created_by,source)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          workspaceId, master.calendar_id, patch.title ?? master.title,
          patch.start_utc ?? master.start_utc, patch.end_utc ?? master.end_utc,
          patch.timezone ?? master.timezone, patch.occurrence_start_utc, id,
          patch.visibility ?? master.visibility, master.created_by, master.source,
        ],
      );
      return r.rows[0];
    }

    if (scope === "this_and_future") {
      if (!patch.occurrence_start_utc) throw new Error("occurrence_start_utc required");
      const until = new Date(new Date(patch.occurrence_start_utc).getTime() - 1000)
        .toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const newRrule = master.rrule ? `${master.rrule};UNTIL=${until}` : master.rrule;
      const r = await c.query(`UPDATE events SET rrule=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, newRrule]);
      return r.rows[0];
    }

    // all
    const r = await c.query(
      `UPDATE events SET title=COALESCE($2,title), start_utc=COALESCE($3,start_utc),
         end_utc=COALESCE($4,end_utc), timezone=COALESCE($5,timezone),
         visibility=COALESCE($6,visibility), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, patch.title ?? null, patch.start_utc ?? null, patch.end_utc ?? null,
       patch.timezone ?? null, patch.visibility ?? null],
    );
    return r.rows[0];
  });
}

/**
 * 依 scope 刪除（EV-3/4）：
 * - this：該次加入 master.exdate（不刪 row，REC-4）。
 * - this_and_future：rrule 加 UNTIL 截斷。
 * - all：軟刪 master（deleted_at）。
 */
export async function deleteEvent(
  workspaceId: string,
  id: string,
  scope: Scope,
  occurrenceStartUtc?: string,
) {
  return withWorkspace(workspaceId, async (c) => {
    if (scope === "this") {
      if (!occurrenceStartUtc) throw new Error("occurrence_start_utc required for scope=this");
      await c.query(
        `UPDATE events SET exdate = array_append(COALESCE(exdate,'{}'), $2::timestamptz), updated_at=now()
         WHERE id=$1`,
        [id, occurrenceStartUtc],
      );
      return;
    }
    if (scope === "this_and_future") {
      if (!occurrenceStartUtc) throw new Error("occurrence_start_utc required");
      const until = new Date(new Date(occurrenceStartUtc).getTime() - 1000)
        .toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      await c.query(`UPDATE events SET rrule = rrule || ';UNTIL=' || $2, updated_at=now() WHERE id=$1`, [id, until]);
      return;
    }
    // all：軟刪
    await c.query(`UPDATE events SET deleted_at=now() WHERE id=$1`, [id]);
  });
}

/** 列表：有 from/to 時展開 occurrences（REC-2）。 */
export async function listOccurrences(
  workspaceId: string,
  from: Date,
  to: Date,
  calendarId?: string,
): Promise<Occurrence[]> {
  return withWorkspace(workspaceId, async (c) => {
    // master + single（rrule 有值或無 recurrence_id 的非 exception）
    const masters = (
      await c.query(
        `SELECT * FROM events
         WHERE deleted_at IS NULL AND recurrence_id IS NULL
           ${calendarId ? "AND calendar_id = $1" : ""}`,
        calendarId ? [calendarId] : [],
      )
    ).rows;

    const all: Occurrence[] = [];
    for (const m of masters) {
      // 撈該 master 的 exceptions
      const exceptions = (
        await c.query(`SELECT * FROM events WHERE master_id = $1 AND deleted_at IS NULL`, [m.id])
      ).rows.map((e) => ({
        id: e.id,
        recurrence_id: new Date(e.recurrence_id).toISOString(),
        start_utc: new Date(e.start_utc).toISOString(),
        end_utc: new Date(e.end_utc).toISOString(),
        title: e.title,
      }));
      all.push(
        ...expandOccurrences(
          {
            id: m.id,
            title: m.title,
            location: m.location ?? null,
            start_utc: new Date(m.start_utc).toISOString(),
            end_utc: new Date(m.end_utc).toISOString(),
            timezone: m.timezone,
            rrule: m.rrule,
            rdate: (m.rdate ?? []).map((d: Date) => new Date(d).toISOString()),
            exdate: (m.exdate ?? []).map((d: Date) => new Date(d).toISOString()),
            source: m.source,
          },
          exceptions,
          from,
          to,
        ),
      );
    }
    return all.sort((a, b) =>
      a.occurrence_start_utc.localeCompare(b.occurrence_start_utc),
    );
  });
}

/**
 * 本人是否看得到某一筆事件（與 listOccurrencesForMember 同一條規則）：
 * 擁有該事件所在行事曆，或本人被列為 participant。
 *
 * 為何需要它：OPA 的 `event.read` 對 visibility ∈ {public, busy} 的事件是放行的，
 * 而 events.visibility 預設就是 'busy'——若處理器直接回完整事件，任何同 workspace
 * 成員只要有 event id 就能讀到別人的標題/描述/地點。"busy" 的語意是「只讓別人知道
 * 我這段時間忙」，不是「內容全公開」，故在資料層再做一次本人核對。
 */
export async function memberCanSeeEvent(
  workspaceId: string,
  memberId: string,
  eventId: string,
): Promise<boolean> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT 1 FROM events e
         LEFT JOIN calendars cal ON cal.id = e.calendar_id
         LEFT JOIN event_participants ep ON ep.event_id = e.id AND ep.member_id = $2
        WHERE e.id = $1 AND (cal.owner_id = $2 OR ep.member_id = $2)
        LIMIT 1`,
      [eventId, memberId],
    );
    return r.rowCount === 1;
  });
}

/**
 * 嚴格個人隔離查詢：只回「本人的日曆事件」——
 *   (a) 本人擁有的 calendar（calendars.owner_id = memberId）上的事件，或
 *   (b) 本人被列為 participant（event_participants.member_id = memberId）的事件。
 * 供站內/外部 agent 查詢用：agent 永遠查不到別人的私會（同 workspace 亦然）。
 * workspace 隔離仍由 RLS 兜底（withWorkspace）。
 */
export async function listOccurrencesForMember(
  workspaceId: string,
  memberId: string,
  from: Date,
  to: Date,
): Promise<Occurrence[]> {
  return withWorkspace(workspaceId, async (c) => {
    const masters = (
      await c.query(
        `SELECT DISTINCT e.* FROM events e
           LEFT JOIN calendars cal ON cal.id = e.calendar_id
           LEFT JOIN event_participants ep ON ep.event_id = e.id AND ep.member_id = $1
          WHERE e.deleted_at IS NULL AND e.recurrence_id IS NULL
            AND (cal.owner_id = $1 OR ep.member_id = $1)`,
        [memberId],
      )
    ).rows;

    const all: Occurrence[] = [];
    for (const m of masters) {
      const exceptions = (
        await c.query(`SELECT * FROM events WHERE master_id = $1 AND deleted_at IS NULL`, [m.id])
      ).rows.map((e) => ({
        id: e.id,
        recurrence_id: new Date(e.recurrence_id).toISOString(),
        start_utc: new Date(e.start_utc).toISOString(),
        end_utc: new Date(e.end_utc).toISOString(),
        title: e.title,
      }));
      all.push(
        ...expandOccurrences(
          {
            id: m.id, title: m.title, location: m.location ?? null,
            start_utc: new Date(m.start_utc).toISOString(),
            end_utc: new Date(m.end_utc).toISOString(),
            timezone: m.timezone, rrule: m.rrule,
            rdate: (m.rdate ?? []).map((d: Date) => new Date(d).toISOString()),
            exdate: (m.exdate ?? []).map((d: Date) => new Date(d).toISOString()),
            source: m.source,
          },
          exceptions, from, to,
        ),
      );
    }
    return all.sort((a, b) => a.occurrence_start_utc.localeCompare(b.occurrence_start_utc));
  });
}
