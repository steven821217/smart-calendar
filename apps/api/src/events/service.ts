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
            id: m.id, title: m.title,
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
