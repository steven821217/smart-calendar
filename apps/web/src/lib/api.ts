/**
 * API client：統一帶 Bearer token、解析 RFC 7807 problem+json。
 * workspace 脈絡永遠來自 token（ISO-3），前端不傳 workspace。
 */

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

/** API 基底位址（SSE EventSource URL 用；容器化時為 "" → 同源相對路徑打 gateway）。 */
export function apiBase() {
  return BASE;
}

export interface Me {
  membership_id: string;
  email: string;
  display_name: string;
  role: string;
  timezone: string;
  workspace: { id: string; slug: string; name: string };
}

export interface LoginResult {
  access_token: string;
  token_type: string;
  expires_in: number;
  me: Me;
}

export interface Occurrence {
  event_id: string;
  occurrence_start_utc: string;
  occurrence_end_utc: string;
  title: string;
  timezone: string;
  kind: "master_instance" | "exception";
  is_exception: boolean;
  exception_id: string | null;
  source: string; // app | agent
}

export interface EventRecord {
  id: string;
  workspace_id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  start_utc: string;
  end_utc: string;
  timezone: string;
  rrule: string | null;
  visibility: string;
  location: string | null;
  source: string;
  created_by: string;
}

export interface AvailabilitySlot {
  start_utc: string;
  end_utc: string;
  score?: number;
  all_participants_free?: boolean;
}

/** NL 解析草稿（POST /v1/events/parse）。 */
export interface EventDraft {
  title: string;
  start_utc: string;
  end_utc: string;
  timezone: string;
  all_day: boolean;
  rrule: string | null;
  confidence: number;
  warnings: string[];
}

/** GET /v1/agents 的一列（audit_log 聚合而來）。 */
export interface AgentSummary {
  agent_id: string;
  actions: number;
  last_activity: string | null;
  scopes: string[];
  revoked: boolean;
}

/** 稽核時間軸一列（GET /v1/agents/:id/activity、/v1/audit）。 */
export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_type: "user" | "agent" | "system";
  on_behalf_of: string | null;
  agent_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  decision: string | null;
  metadata: Record<string, unknown>;
  at: string;
}

/** RFC 7807 錯誤，攜帶 status 與 conflict 附加欄位（供 409 建議時段）。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail?: string,
    public body?: Record<string, unknown>,
  ) {
    super(detail || title);
    this.name = "ApiError";
  }
}

let _token: string | null = null;
export function setToken(t: string | null) {
  _token = t;
}
export function getToken() {
  return _token;
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (_token) headers.authorization = `Bearer ${_token}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts.headers) Object.assign(headers, opts.headers);

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const p = (json ?? {}) as Record<string, unknown>;
    throw new ApiError(
      res.status,
      (p.title as string) ?? `HTTP ${res.status}`,
      p.detail as string | undefined,
      p,
    );
  }
  return json as T;
}

export const api = {
  login: (email: string) => request<LoginResult>("POST", "/v1/auth/login", { body: { email } }),
  me: () => request<Me>("GET", "/v1/auth/me"),

  listCalendars: () =>
    request<{ calendars: { id: string; name: string; owner_id: string }[] }>(
      "GET",
      "/v1/calendars",
    ),

  listOccurrences: (fromUtc: string, toUtc: string, calendarId?: string) =>
    request<{ occurrences: Occurrence[]; next_cursor: string | null }>(
      "GET",
      `/v1/events?from=${encodeURIComponent(fromUtc)}&to=${encodeURIComponent(toUtc)}${
        calendarId ? `&calendar_id=${calendarId}` : ""
      }`,
    ),

  getEvent: (id: string) => request<EventRecord>("GET", `/v1/events/${id}`),

  createEvent: (
    input: {
      calendar_id: string;
      title: string;
      description?: string | null;
      start_utc: string;
      end_utc: string;
      timezone: string;
      rrule?: string | null;
      visibility?: string;
      location?: string | null;
    },
    idempotencyKey?: string,
  ) => request<EventRecord>("POST", "/v1/events", { body: input, idempotencyKey }),

  updateEvent: (
    id: string,
    scope: "this" | "this_and_future" | "all",
    patch: Record<string, unknown>,
  ) => request<EventRecord>("PATCH", `/v1/events/${id}?scope=${scope}`, { body: patch }),

  deleteEvent: (
    id: string,
    scope: "this" | "this_and_future" | "all",
    occurrenceStartUtc?: string,
  ) =>
    request<void>(
      "DELETE",
      `/v1/events/${id}?scope=${scope}${
        occurrenceStartUtc ? `&occurrence_start_utc=${encodeURIComponent(occurrenceStartUtc)}` : ""
      }`,
    ),

  availability: (fromUtc: string, toUtc: string, durationMinutes: number, memberIds?: string[]) =>
    request<{ slots: AvailabilitySlot[] }>(
      "GET",
      `/v1/availability?from=${encodeURIComponent(fromUtc)}&to=${encodeURIComponent(
        toUtc,
      )}&duration_minutes=${durationMinutes}${memberIds?.length ? `&member_ids=${memberIds.join(",")}` : ""}`,
    ),

  // NL → 草稿（9.5, POST /v1/events/parse）
  parseText: (text: string, defaultTimezone: string, referenceNowUtc?: string) =>
    request<{ draft: EventDraft }>("POST", "/v1/events/parse", {
      body: { text, default_timezone: defaultTimezone, reference_now_utc: referenceNowUtc },
    }),

  // --- Agent & MCP 管理（Admin，9.9）---
  listAgents: () => request<{ agents: AgentSummary[] }>("GET", "/v1/agents"),
  getAgent: (id: string) => request<AgentSummary>("GET", `/v1/agents/${encodeURIComponent(id)}`),
  revokeAgent: (id: string) =>
    request<void>("DELETE", `/v1/agents/${encodeURIComponent(id)}/authorization`),
  agentActivity: (id: string, before?: string) =>
    request<{ entries: AuditEntry[]; next_cursor: string | null }>(
      "GET",
      `/v1/agents/${encodeURIComponent(id)}/activity${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  auditTimeline: (before?: string) =>
    request<{ entries: AuditEntry[]; next_cursor: string | null }>(
      "GET",
      `/v1/audit?actor_type=agent${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),

  // --- 團隊群組（feature-team-groups）---
  listGroups: () => request<{ groups: Group[] }>("GET", "/v1/groups"),
  createGroup: (name: string) => request<Group>("POST", "/v1/groups", { body: { name } }),
  deleteGroup: (id: string) => request<void>("DELETE", `/v1/groups/${encodeURIComponent(id)}`),
  listGroupMembers: (id: string) =>
    request<{ members: GroupMember[] }>("GET", `/v1/groups/${encodeURIComponent(id)}/members`),
  addGroupMember: (id: string, userId: string, role: "leader" | "member") =>
    request<GroupMember>("POST", `/v1/groups/${encodeURIComponent(id)}/members`, {
      body: { user_id: userId, role },
    }),
  removeGroupMember: (id: string, userId: string) =>
    request<void>("DELETE", `/v1/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`),
  listWorkspaceMembers: () => request<{ members: WorkspaceMember[] }>("GET", "/v1/members"),

  // --- 站內對話 agent（B）：能查詢也能排會 ---
  agentChat: (text: string, viewerTz: string) =>
    request<{
      kind: "answer" | "scheduled" | "needs_decision" | "error";
      message: string;
      intent?: string;
      via?: string;
      data?: { option_token?: string; [k: string]: unknown };
    }>("POST", "/v1/agent/chat", { body: { text }, headers: { "x-viewer-tz": viewerTz } }),
  agentConfirm: (optionToken: string) =>
    request<{ kind: string; message: string; data?: unknown }>("POST", "/v1/agent/confirm", {
      body: { option_token: optionToken },
    }),

  // --- RSVP（feature-team-groups）：以 rsvp_token 回覆 pending 邀請（免登入 JWT）---
  listPendingRsvps: () =>
    request<{
      pending: Array<{ event_id: string; title: string; start_utc: string; end_utc: string; timezone: string; location: string | null; rsvp_token: string }>;
    }>("GET", "/v1/me/pending-rsvps"),
  rsvp: (eventId: string, optionToken: string, decision: "accept" | "decline") =>
    request<{
      status: string;
      event_id: string;
      member_id: string;
      rsvp_status: string;
      event?: { title: string; start_utc: string; end_utc: string; timezone: string; location: string | null };
    }>(
      "POST",
      `/v1/events/${encodeURIComponent(eventId)}/rsvp`,
      { body: { option_token: optionToken, decision } },
    ),
};

/** 團隊群組（feature-team-groups）。 */
export interface Group {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}
export interface GroupMember {
  id: string;
  group_id: string;
  user_id: string;
  membership_id: string | null;
  display_name: string | null;
  role: "leader" | "member";
}
export interface WorkspaceMember {
  membership_id: string;
  user_id: string;
  display_name: string;
  role: string;
}
