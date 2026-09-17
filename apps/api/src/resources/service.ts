import { withWorkspace } from "../db/pool.js";

export interface BookArgs {
  resource_id: string;
  event_id: string;
  start_utc: string;
  end_utc: string;
}

export class BookingConflictError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BookingConflictError";
  }
}

export interface CreateResourceArgs {
  name: string;
  type?: "room" | "equipment";
  capacity?: number | null;
}

/** 列本 workspace 資源（RLS 兜底）。 */
export async function listResources(workspaceId: string) {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT id, name, type, capacity, availability, created_at
         FROM resources ORDER BY name`,
    );
    return r.rows;
  });
}

/** 建立資源（resource.create）。 */
export async function createResource(workspaceId: string, args: CreateResourceArgs) {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `INSERT INTO resources(workspace_id,name,type,capacity)
       VALUES($1,$2,$3,$4) RETURNING id, name, type, capacity, availability, created_at`,
      [workspaceId, args.name, args.type ?? "room", args.capacity ?? null],
    );
    return r.rows[0];
  });
}

/**
 * 取消預訂（resource.book）。回傳被刪的列；無此列（含跨 workspace，RLS 過濾）回 null，
 * 由路由層對映 404（不洩漏存在性）。 */
export async function cancelBooking(
  workspaceId: string,
  resourceId: string,
  bookingId: string,
) {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `DELETE FROM resource_bookings
        WHERE id = $1 AND resource_id = $2 RETURNING id`,
      [bookingId, resourceId],
    );
    return r.rows[0] ?? null;
  });
}

/**
 * 預訂資源。DB 的 EXCLUDE USING gist 保證同資源時段不重疊（REQ-R2）；
 * 命中則丟 BookingConflictError（路由層對映 409）。
 */
export async function bookResource(workspaceId: string, args: BookArgs) {
  return withWorkspace(workspaceId, async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO resource_bookings(workspace_id,resource_id,event_id,start_utc,end_utc)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [workspaceId, args.resource_id, args.event_id, args.start_utc, args.end_utc],
      );
      return r.rows[0];
    } catch (e: unknown) {
      // 23P01 = exclusion_violation
      if (typeof e === "object" && e && (e as { code?: string }).code === "23P01") {
        throw new BookingConflictError("resource already booked for this time range");
      }
      throw e;
    }
  });
}
