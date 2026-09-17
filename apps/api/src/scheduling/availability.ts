import { withWorkspace } from "../db/pool.js";
import { listOccurrences } from "../events/service.js";
import { findSlots, type Interval, type Slot } from "./freebusy.js";

export interface AvailabilityArgs {
  from_utc: string;
  to_utc: string;
  duration_minutes: number;
  member_ids?: string[]; // 參與者 membership id；空 → 全 workspace busy
  max_results?: number;
}

export interface AvailabilitySlot extends Slot {
  all_participants_free: boolean;
}

/**
 * 共同空檔（GET /v1/availability, REQ-S1/S2）。
 * 忙碌來源：窗口內展開的 occurrences（RLS 限本 workspace）。
 * private 事件仍計為 busy（只反映 free/busy，不洩漏內容，UI-6/§10）。
 * 指定 member_ids 時只計該些成員為參與者的事件。
 */
export async function computeAvailability(
  workspaceId: string,
  args: AvailabilityArgs,
): Promise<{ slots: AvailabilitySlot[] }> {
  const from = new Date(args.from_utc);
  const to = new Date(args.to_utc);
  const occ = await listOccurrences(workspaceId, from, to);

  let busyEventIds: Set<string> | null = null;
  if (args.member_ids && args.member_ids.length > 0) {
    busyEventIds = await withWorkspace(workspaceId, async (c) => {
      const r = await c.query(
        `SELECT DISTINCT event_id FROM event_participants
          WHERE member_id = ANY($1::uuid[])`,
        [args.member_ids],
      );
      return new Set<string>(r.rows.map((x) => x.event_id));
    });
  }

  const busy: Interval[] = occ
    .filter((o) => (busyEventIds ? busyEventIds.has(o.event_id) : true))
    .map((o) => ({
      start: new Date(o.occurrence_start_utc).getTime(),
      end: new Date(o.occurrence_end_utc).getTime(),
    }));

  const slots = findSlots(
    busy,
    from.getTime(),
    to.getTime(),
    args.duration_minutes * 60_000,
    args.max_results ?? 5,
  );
  // 目前忙碌集合為聚合，任何回傳的候選都對「已納入的成員」皆空 → all_participants_free
  return { slots: slots.map((s) => ({ ...s, all_participants_free: true })) };
}
