import Redis from "ioredis";
import { withWorkspace } from "../db/pool.js";

/**
 * Agent 授權管理（frontend.md §9 / api.md 31-35）。
 *
 * 本系統沒有獨立 agents 表：外部 AI 以帶 scope 的 M2M JWT（sub=agent_id）呼叫 MCP，
 * 每次動作都寫 audit_log（actor_type='agent', agent_id, source=agent）。因此：
 *  - 「已授權 agent 清單」＝ audit_log 中出現過的 distinct agent_id（本 workspace，RLS）。
 *  - 「撤銷授權」＝ 寫入 Redis 黑名單，PEP/guard 於下次呼叫即時 fail-closed（MCP-8）。
 */

const redis = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

function revokeKey(workspaceId: string, agentId: string) {
  return `agent:revoked:${workspaceId}:${agentId}`;
}

/** 撤銷授權（即時生效）。TTL 對齊 token 最長壽命即可，此處保守設 24h。 */
export async function revokeAgent(workspaceId: string, agentId: string, ttlSec = 86_400) {
  await redis.set(revokeKey(workspaceId, agentId), "1", "EX", ttlSec);
}

/** 解除撤銷（重新授權）。 */
export async function unrevokeAgent(workspaceId: string, agentId: string) {
  await redis.del(revokeKey(workspaceId, agentId));
}

/** guard/PEP 每次呼叫前查詢：該 agent 是否已被撤銷（ZT + MCP-8）。 */
export async function isAgentRevoked(workspaceId: string, agentId: string): Promise<boolean> {
  const v = await redis.get(revokeKey(workspaceId, agentId));
  return v === "1";
}

export interface AgentSummary {
  agent_id: string;
  actions: number;
  last_activity: string | null;
  scopes: string[]; // 從稽核 metadata 聚合的近期 scope
  revoked: boolean;
}

/** 列本 workspace 已授權（曾活動）的 agent。 */
export async function listAgents(workspaceId: string): Promise<AgentSummary[]> {
  const rows = await withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT agent_id,
              count(*)::int AS actions,
              max(at) AS last_activity,
              coalesce(
                jsonb_agg(DISTINCT metadata->'scope') FILTER (WHERE metadata ? 'scope'),
                '[]'::jsonb) AS scope_lists
         FROM audit_log
        WHERE actor_type = 'agent' AND agent_id IS NOT NULL
        GROUP BY agent_id
        ORDER BY max(at) DESC`,
    );
    return r.rows;
  });
  const out: AgentSummary[] = [];
  for (const row of rows) {
    const scopes = new Set<string>();
    for (const lst of (row.scope_lists as unknown[]) ?? []) {
      if (Array.isArray(lst)) for (const s of lst) scopes.add(String(s));
    }
    out.push({
      agent_id: row.agent_id,
      actions: row.actions,
      last_activity: row.last_activity ? new Date(row.last_activity).toISOString() : null,
      scopes: [...scopes],
      revoked: await isAgentRevoked(workspaceId, row.agent_id),
    });
  }
  return out;
}

/** 單一 agent 詳情（不存在 → null）。 */
export async function getAgent(workspaceId: string, agentId: string): Promise<AgentSummary | null> {
  const all = await listAgents(workspaceId);
  return all.find((a) => a.agent_id === agentId) ?? null;
}

// ---------------------------------------------------------------------------
// 委員會（LangGraph）Service 層擴充
// listMembers（A.5）、buffer/vehicle helpers（C.1/C.3）、commitSchedulingPlan（C.4 + 功能 A）
// 所有 DB 動作沿用 withWorkspace（RLS 兜底），workspace 一律來自 ctx（ZT-5）。
// ---------------------------------------------------------------------------
import type { PoolClient } from "pg";
import type { AuthContext } from "../auth/jwt.js";
import { writeAudit } from "../audit/service.js";
import { signRsvpToken } from "./option_token.js";

export interface MemberRow {
  membership_id: string;
  display_name: string;
}

/**
 * 列本 workspace 成員（A.5）：供 Coordinator 做名字→membership 唯一比對。
 * 回 { membership_id, display_name }；RLS 兜底，僅本 workspace。
 */
export async function listMembers(workspaceId: string): Promise<MemberRow[]> {
  return withWorkspace(workspaceId, async (c: PoolClient) => {
    const r = await c.query(
      `SELECT m.id AS membership_id, u.display_name
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.status = 'active'
        ORDER BY u.display_name`,
    );
    return r.rows as MemberRow[];
  });
}

// --- Buffer / vehicle 設定（C.1）------------------------------------------

/** 交接 buffer（分鐘）；預設 15，可配置。 */
export function handoverBufferMinutes(): number {
  const v = Number(process.env.RESOURCE_HANDOVER_BUFFER_MINUTES);
  return Number.isFinite(v) && v >= 0 ? v : 15;
}

/** 公務車會前提醒提前量（分鐘）；預設 30（功能 A）。 */
export function vehicleReminderLeadMinutes(): number {
  const v = Number(process.env.VEHICLE_REMINDER_LEAD_MINUTES);
  return Number.isFinite(v) && v >= 0 ? v : 30;
}

/** 視為「需交接」的資源 DB type 集合（預設含 equipment）。 */
function vehicleTypes(): Set<string> {
  const raw = process.env.RESOURCE_VEHICLE_TYPES ?? "equipment";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

const VEHICLE_KEYWORDS = ["公務車", "vehicle", "car", "van", "車"];

/**
 * 判定資源是否「需交接」（C.1）：type ∈ RESOURCE_VEHICLE_TYPES
 * 且名稱/metadata 帶 vehicle 關鍵字。vehicle 為應用層概念（DB 無此 type）。
 */
export function isHandoverResource(resource: {
  type?: string | null;
  name?: string | null;
  availability?: Record<string, unknown> | null;
}): boolean {
  if (!vehicleTypes().has(String(resource.type ?? ""))) return false;
  const name = String(resource.name ?? "").toLowerCase();
  if (VEHICLE_KEYWORDS.some((k) => name.includes(k.toLowerCase()))) return true;
  const meta = resource.availability ?? {};
  return meta && (meta as Record<string, unknown>).handover === true;
}

/** 對需交接資源把區間各外擴 buffer 分鐘（策略 b，C.2）。 */
export function expandWithBuffer(
  startUtc: string,
  endUtc: string,
  bufferMinutes: number,
): { start_utc: string; end_utc: string } {
  const b = bufferMinutes * 60_000;
  return {
    start_utc: new Date(new Date(startUtc).getTime() - b).toISOString(),
    end_utc: new Date(new Date(endUtc).getTime() + b).toISOString(),
  };
}

/** 讀取/顯示時扣回 buffer 的 helper（C.3）。 */
export function shrinkBuffer(
  startUtc: string,
  endUtc: string,
  bufferMinutes: number,
): { start_utc: string; end_utc: string } {
  const b = bufferMinutes * 60_000;
  return {
    start_utc: new Date(new Date(startUtc).getTime() + b).toISOString(),
    end_utc: new Date(new Date(endUtc).getTime() - b).toISOString(),
  };
}

// --- 原子落實（C.4 + 功能 A）----------------------------------------------

export class SchedulingCommitError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg);
    this.name = "SchedulingCommitError";
  }
}

export interface CommitPlan {
  calendar_id: string;
  title: string;
  timezone: string;
  // 事件（實際使用）時段
  actual_start_utc: string;
  actual_end_utc: string;
  attendees: string[]; // membership id
  // 委派型參與者（Leader 幫 Member 排）：這些以 rsvp_status='pending' 落實，並各產 rsvp_token
  // （feature-team-groups Req 2.2 / 3.1）。須為 attendees 的子集。
  delegated_attendees?: string[];
  // 資源預訂（需交接資源含 buffer）
  resource_id: string;
  booking_start_utc: string; // 可能含 buffer
  booking_end_utc: string;
  needs_handover: boolean;
}

export interface RsvpInvitation {
  member_id: string;
  event_id: string;
  rsvp_token: string;
}

export interface CommitResult {
  event: Record<string, unknown>;
  booking: Record<string, unknown>;
  reminders: Array<Record<string, unknown>>;
  actual_usage: { start_utc: string; end_utc: string };
  // 委派型成員的一鍵回覆邀請（feature-team-groups）
  rsvp_invitations: RsvpInvitation[];
}

/**
 * commitSchedulingPlan（C.4）：單一 withWorkspace 交易內依序
 *   1) insert event（source=agent）
 *   2) event_participants（每個 attendee）
 *   3) resource_bookings（含 buffer；EXCLUDE gist 為最終防線）
 *   4) event_reminders（功能 A：需交接資源會前提醒）
 * 任一步失敗整筆 rollback（REQ-3.8）。BookingConflict → SchedulingCommitError('booking_conflict')。
 */
export async function commitSchedulingPlan(
  ctx: AuthContext,
  plan: CommitPlan,
): Promise<CommitResult> {
  return withWorkspace(ctx.workspace, async (c: PoolClient) => {
    // 1) event
    const ev = (
      await c.query(
        `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by,source)
         VALUES($1,$2,$3,$4,$5,$6,$7,'agent') RETURNING *`,
        [
          ctx.workspace,
          plan.calendar_id,
          plan.title,
          plan.actual_start_utc,
          plan.actual_end_utc,
          plan.timezone,
          ctx.sub,
        ],
      )
    ).rows[0];

    // 2) participants（REQ-3.7）
    // 委派型成員以 rsvp_status='pending' 落實（待 Member 同意才正式排入）；
    // 非委派（Leader 自己 / 明確指名且非團隊派發）預設 'accepted'（feature-team-groups Req 2.2）。
    const delegated = new Set(plan.delegated_attendees ?? []);
    const rsvp_invitations: RsvpInvitation[] = [];
    for (const memberId of plan.attendees) {
      const status = delegated.has(memberId) ? "pending" : "accepted";
      await c.query(
        `INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (event_id, member_id) DO UPDATE SET rsvp_status = EXCLUDED.rsvp_status`,
        [ctx.workspace, ev.id, memberId, status],
      );
      if (delegated.has(memberId)) {
        rsvp_invitations.push({
          member_id: memberId,
          event_id: ev.id,
          rsvp_token: signRsvpToken({ kind: "rsvp", workspace: ctx.workspace, event_id: ev.id, member_id: memberId }),
        });
      }
    }

    // 3) booking（含 buffer）— EXCLUDE gist 命中 → 23P01
    let booking: Record<string, unknown>;
    try {
      booking = (
        await c.query(
          `INSERT INTO resource_bookings(workspace_id,resource_id,event_id,start_utc,end_utc)
           VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [ctx.workspace, plan.resource_id, ev.id, plan.booking_start_utc, plan.booking_end_utc],
        )
      ).rows[0];
    } catch (e: unknown) {
      if (typeof e === "object" && e && (e as { code?: string }).code === "23P01") {
        throw new SchedulingCommitError("booking_conflict", "resource already booked for this time range");
      }
      throw e;
    }

    // 4) reminders（功能 A）：需交接資源 → 會前 lead 分鐘 email
    const reminders: Array<Record<string, unknown>> = [];
    if (plan.needs_handover) {
      const lead = vehicleReminderLeadMinutes();
      const rem = (
        await c.query(
          `INSERT INTO event_reminders(workspace_id,event_id,member_id,lead_minutes,channel)
           VALUES($1,$2,$3,$4,'email')
           ON CONFLICT (event_id, member_id, lead_minutes, channel) DO UPDATE SET enabled=true
           RETURNING id, event_id, member_id, lead_minutes, channel, enabled, created_at`,
          [ctx.workspace, ev.id, plan.attendees[0] ?? null, lead],
        )
      ).rows[0];
      reminders.push(rem);
    }

    // 落實稽核（併入同一交易；MCP-13 / REQ-3.5）
    await writeAudit(
      ctx.workspace,
      {
        actor_type: "agent",
        agent_id: ctx.sub,
        on_behalf_of: ctx.sub,
        action: "committee.commit",
        target_type: "event",
        target_id: ev.id,
        decision: "allow",
        metadata: { tool: "delegate_complex_scheduling", resource_id: plan.resource_id },
      },
      c,
    );

    return {
      event: ev,
      booking,
      reminders,
      actual_usage: { start_utc: plan.actual_start_utc, end_utc: plan.actual_end_utc },
      rsvp_invitations,
    };
  });
}
