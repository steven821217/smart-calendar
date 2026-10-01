import type { AuthContext } from "../../auth/jwt.js";
import { withWorkspace } from "../../db/pool.js";
import { listOccurrencesForMember } from "../../events/service.js";
import { computeAvailability } from "../../scheduling/availability.js";
import type { Occurrence } from "../../events/recurrence.js";

/**
 * 站內 agent 的確定性查詢 function（第一波 B1/B2/B3/B5/B6 + 第二波 B4/B7/B8）。
 *
 * 設計原則（依使用者要求）：14B 只負責「選 function + 抽參數」，真實答案一律由這裡的
 * 確定性程式碼算出（可單元測試、可稽核、絕不編造），最後交給潤飾層組裝自然語言。
 * 全部走 listOccurrencesForMember / RLS，維持嚴格個人隔離（查不到他人的私會）。
 */

/** B2：現在起最近的 N 筆事件（跨窗，預設看未來 60 天）。 */
export async function nextEvents(
  auth: AuthContext, now: Date, count = 1, lookaheadDays = 60,
): Promise<Occurrence[]> {
  const to = new Date(now.getTime() + lookaheadDays * 86400_000);
  const occ = await listOccurrencesForMember(auth.workspace, auth.sub, now, to);
  return occ
    .filter((o) => new Date(o.occurrence_start_utc) >= now)
    .sort((a, b) => +new Date(a.occurrence_start_utc) - +new Date(b.occurrence_start_utc))
    .slice(0, Math.max(1, count));
}

/** B1：某 occurrence 的完整細節（地點/起訖/時長/與會者/來源）。以事件標題或時間定位。 */
export interface EventDetail {
  event_id: string;
  title: string;
  start_utc: string;
  end_utc: string;
  duration_minutes: number;
  timezone: string;
  location: string | null;
  description: string | null;
  source: string;
  attendees: Array<{ name: string; rsvp_status: string }>;
}

export async function eventDetail(
  auth: AuthContext, occ: Occurrence,
): Promise<EventDetail> {
  const durationMinutes = Math.round(
    (+new Date(occ.occurrence_end_utc) - +new Date(occ.occurrence_start_utc)) / 60000,
  );
  const { location, description, attendees } = await withWorkspace(auth.workspace, async (c) => {
    const ev = (await c.query(
      `SELECT location, description FROM events WHERE id=$1 AND deleted_at IS NULL`, [occ.event_id],
    )).rows[0] ?? {};
    const at = await c.query(
      `SELECT u.display_name AS name, ep.rsvp_status
         FROM event_participants ep
         JOIN memberships m ON m.id = ep.member_id
         JOIN users u ON u.id = m.user_id
        WHERE ep.event_id=$1
        ORDER BY u.display_name`,
      [occ.event_id],
    );
    return {
      location: ev.location ?? null,
      description: ev.description ?? null,
      attendees: at.rows.map((r) => ({ name: r.name as string, rsvp_status: r.rsvp_status as string })),
    };
  });
  return {
    event_id: occ.event_id, title: occ.title,
    start_utc: occ.occurrence_start_utc, end_utc: occ.occurrence_end_utc,
    duration_minutes: durationMinutes, timezone: occ.timezone,
    location, description, source: occ.source, attendees,
  };
}

/** B3：跨時間（不限窗）依標題關鍵字搜尋本人事件。range 控制過去/未來/全部。 */
export async function searchEvents(
  auth: AuthContext, keyword: string, now: Date,
  range: "all" | "future" | "past" = "future", spanDays = 365, max = 10,
): Promise<Occurrence[]> {
  const from = range === "future" ? now : new Date(now.getTime() - spanDays * 86400_000);
  const to = range === "past" ? now : new Date(now.getTime() + spanDays * 86400_000);
  const occ = await listOccurrencesForMember(auth.workspace, auth.sub, from, to);
  return occ
    // 標題或地點命中都算：使用者常用會議室名稱指稱一批會議。
    .filter((o) => o.title.includes(keyword) || (o.location?.includes(keyword) ?? false))
    .sort((a, b) => +new Date(a.occurrence_start_utc) - +new Date(b.occurrence_start_utc))
    .slice(0, max);
}

/**
 * 本 workspace 的成員顯示名稱。
 * 用途與 groups 相同：讓路由層能**確定性**辨認句中的人名，不必依賴 14B 填 person_name
 *（實測「周雅婷在哪些會議裡？」模型會漏填，結果退化成要求使用者給關鍵字）。
 */
export async function listMemberNames(workspaceId: string): Promise<string[]> {
  return withWorkspace(workspaceId, async (c) => {
    const rows = (
      await c.query(
        `SELECT u.display_name FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.status='active' AND u.display_name IS NOT NULL`,
      )
    ).rows as Array<{ display_name: string }>;
    return rows.map((r) => r.display_name).filter((n) => n && n.length >= 2);
  });
}

/** B4：找「本人與某人（依 display_name）同時參與」的事件。 */
export async function eventsWithPerson(
  auth: AuthContext, personName: string, now: Date,
  range: "all" | "future" | "past" = "future", spanDays = 365, max = 10,
): Promise<{ resolvedName: string | null; events: Occurrence[] }> {
  // 解析 personName → 該 workspace 的 membership_id（模糊比對 display_name，恰好一個才採用）
  const target = await withWorkspace(auth.workspace, async (c) => {
    const r = await c.query(
      `SELECT m.id AS membership_id, u.display_name
         FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE u.display_name ILIKE '%' || $1 || '%' AND m.status='active'`,
      [personName],
    );
    return r.rows.length === 1 ? { id: r.rows[0].membership_id as string, name: r.rows[0].display_name as string } : null;
  });
  if (!target) return { resolvedName: null, events: [] };

  const from = range === "future" ? now : new Date(now.getTime() - spanDays * 86400_000);
  const to = range === "past" ? now : new Date(now.getTime() + spanDays * 86400_000);
  const mine = await listOccurrencesForMember(auth.workspace, auth.sub, from, to);
  // 該人也參與的 event_id 集合
  const theirEventIds = await withWorkspace(auth.workspace, async (c) => {
    const r = await c.query(
      `SELECT DISTINCT event_id FROM event_participants WHERE member_id=$1`, [target.id],
    );
    return new Set<string>(r.rows.map((x) => x.event_id));
  });
  const events = mine
    .filter((o) => theirEventIds.has(o.event_id))
    .sort((a, b) => +new Date(a.occurrence_start_utc) - +new Date(b.occurrence_start_utc))
    .slice(0, max);
  return { resolvedName: target.name, events };
}

/** B5/B6：找空檔——支援指定時長、以及「現在起最近一個」。 */
export async function freeSlots(
  auth: AuthContext, fromUtc: string, toUtc: string,
  durationMinutes = 60, maxResults = 5,
): Promise<Array<{ start_utc: string; end_utc: string }>> {
  const { slots } = await computeAvailability(auth.workspace, {
    from_utc: fromUtc, to_utc: toUtc, duration_minutes: durationMinutes,
    max_results: maxResults, member_ids: [auth.sub],
  });
  return slots.map((s) => ({ start_utc: s.start_utc, end_utc: s.end_utc }));
}

/** B7：比較兩個時間窗的負載（數量 + 總時數）。 */
export interface LoadStat { count: number; total_minutes: number; }
export async function loadOf(auth: AuthContext, fromUtc: string, toUtc: string): Promise<LoadStat> {
  const occ = await listOccurrencesForMember(auth.workspace, auth.sub, new Date(fromUtc), new Date(toUtc));
  const total = occ.reduce((s, o) => s + (+new Date(o.occurrence_end_utc) - +new Date(o.occurrence_start_utc)) / 60000, 0);
  return { count: occ.length, total_minutes: Math.round(total) };
}

/** B8：統計——依 weekday / daypart 分組計數（供「我最忙星期幾」「下午常在開會嗎」）。 */
export interface StatsResult {
  total: number;
  byWeekday: number[]; // index 0=週一..6=週日
  byDaypart: { morning: number; afternoon: number; evening: number };
}
export async function stats(
  auth: AuthContext, fromUtc: string, toUtc: string, tz: string,
): Promise<StatsResult> {
  const occ = await listOccurrencesForMember(auth.workspace, auth.sub, new Date(fromUtc), new Date(toUtc));
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  const byDaypart = { morning: 0, afternoon: 0, evening: 0 };
  for (const o of occ) {
    const d = new Date(o.occurrence_start_utc);
    // 當地星期（週一=0）與當地小時
    const wallDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
    const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    if (wallDay in map) byWeekday[map[wallDay]]++;
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d)) % 24;
    if (h >= 6 && h < 12) byDaypart.morning++;
    else if (h >= 12 && h < 18) byDaypart.afternoon++;
    else byDaypart.evening++;
  }
  return { total: occ.length, byWeekday, byDaypart };
}
