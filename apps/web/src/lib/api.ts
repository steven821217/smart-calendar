/**
 * API client：統一帶 Bearer token、解析 RFC 7807 problem+json。
 * workspace 脈絡永遠來自 token（ISO-3），前端不傳 workspace。
 */

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

/** 任何已認證請求收到 401 時通知應用程式清除過期登入狀態。 */
export const AUTH_EXPIRED_EVENT = "scal:auth-expired";

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

/** 登入結果：一個人可能屬於多個 workspace，此時後端不發 token，先要求選擇。 */
export interface WorkspaceChoice {
  id: string;
  slug: string;
  name: string;
  role: string;
}
export type LoginOutcome = LoginResult | { needs_workspace_selection: true; workspaces: WorkspaceChoice[] };

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
  /** 與會者名單（GET /v1/events/:id 與建立回應會帶）。 */
  participants?: EventParticipant[];
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
  const tokenForRequest = _token;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (tokenForRequest) headers.authorization = `Bearer ${tokenForRequest}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts.headers) Object.assign(headers, opts.headers);

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  // 僅清除送出此請求時所用、且目前仍有效的同一張 token。
  // 這可避免舊請求較晚回 401 時誤清掉使用者剛重新登入取得的新 token。
  if (res.status === 401 && tokenForRequest && _token === tokenForRequest) {
    setToken(null);
    localStorage.removeItem("scal.token");
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }

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
  login: (email: string, password: string, workspaceId?: string) =>
    request<LoginOutcome>("POST", "/v1/auth/login", {
      body: workspaceId ? { email, password, workspace_id: workspaceId } : { email, password },
    }),
  /** 我所屬的所有 workspace（切換器用）。 */
  listMyWorkspaces: () =>
    request<{ current_workspace_id: string; workspaces: WorkspaceChoice[] }>(
      "GET",
      "/v1/auth/workspaces",
    ),
  /** 切換到同一個人的另一個 workspace（免重新輸入密碼，token 由伺服器重簽）。 */
  switchWorkspace: (workspaceId: string) =>
    request<LoginResult>("POST", "/v1/auth/switch-workspace", { body: { workspace_id: workspaceId } }),
  /** 在同一個帳號下再建立一個 workspace，建立者為 admin；回應等同已切換過去。 */
  createWorkspace: (name: string, timezone?: string) =>
    request<LoginResult>("POST", "/v1/auth/workspaces", { body: { name, timezone } }),
  /** OAuth 2.1 同意（導向流程）：核准後取得一次性授權碼，由瀏覽器帶回 client。 */
  oauthConsent: (body: {
    agent_id: string;
    scope: string[];
    code_challenge: string;
    redirect_uri: string;
    client_id: string;
    resource?: string;
  }) =>
    request<{ authorization_code: string; expires_in: number }>("POST", "/v1/oauth/consent", { body }),

  /** 把「已註冊」的人以 email 加入本工作區（admin）。 */
  addWorkspaceMember: (email: string, role: "admin" | "scheduler" | "member") =>
    request<{ membership_id: string; user_id: string; display_name: string; role: string }>(
      "POST",
      "/v1/members",
      { body: { email, role, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } },
    ),
  /** 自助註冊：建立新 workspace（註冊者為 admin），成功即回 token（自動登入）。 */
  register: (body: {
    email: string;
    password: string;
    display_name: string;
    workspace_name: string;
    timezone?: string;
  }) => request<LoginResult>("POST", "/v1/auth/register", { body }),
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
      /** 與會者：被邀請的人為 pending，需對方回覆才算排入他的行程。 */
      participants?: Array<{ member_id?: string; guest_email?: string }>;
    },
    idempotencyKey?: string,
  ) => request<EventRecord>("POST", "/v1/events", { body: input, idempotencyKey }),

  /** 取代某事件的與會者名單（僅發起人可改）。 */
  setEventParticipants: (eventId: string, memberIds: string[], guestEmails: string[] = []) =>
    request<{ participants: EventParticipant[] }>(
      "PUT",
      `/v1/events/${encodeURIComponent(eventId)}/participants`,
      { body: { member_ids: memberIds, guest_emails: guestEmails } },
    ),

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
  /** 依 email 找本工作區成員（邀請與會者時用）。查不到回 404。 */
  findMemberByEmail: (email: string) =>
    request<{ member: WorkspaceMember }>(
      "GET",
      `/v1/members/by-email?email=${encodeURIComponent(email)}`,
    ),

  // --- 站內對話 agent（B）：能查詢也能排會 ---
  agentChat: (text: string, viewerTz: string) =>
    request<{
      kind: "answer" | "scheduled" | "needs_decision" | "needs_confirmation" | "not_permitted" | "error";
      message: string;
      intent?: string;
      via?: string;
      data?: { option_token?: string; action_token?: string; [k: string]: unknown };
    }>("POST", "/v1/agent/chat", { body: { text }, headers: { "x-viewer-tz": viewerTz } }),
  agentConfirm: (optionToken: string) =>
    request<{ kind: string; message: string; data?: unknown }>("POST", "/v1/agent/confirm", {
      body: { option_token: optionToken },
    }),
  /**
   * 破壞性動作（改期/取消/回覆邀請）的第二步確認。後端在第一步只回「確認預覽」＋簽好的
   * action_token（綁 workspace、短 TTL），必須帶此 token 才會真的落實。
   */
  agentConfirmAction: (actionToken: string, viewerTz: string) =>
    request<{ kind: string; message: string; intent?: string; data?: unknown }>(
      "POST",
      "/v1/agent/confirm-action",
      { body: { action_token: actionToken }, headers: { "x-viewer-tz": viewerTz } },
    ),

  /**
   * 綁定外部 agent 到「我」的帳號：回一組 scoped、有到期日、可撤銷的 bearer token，
   * 貼進 MCP client 設定即可。權限上限＝呼叫者本人（roles 沿用、scope 為勾選子集）。
   * token 只在此回應出現一次，之後無法再取得。
   */
  createAgentToken: (agentId: string, scope: string[], ttlDays: number) =>
    request<{
      access_token: string;
      token_type: string;
      expires_in: number;
      expires_at: string;
      agent_id: string;
      scope: string[];
      on_behalf_of: string;
    }>("POST", "/v1/agents/tokens", { body: { agent_id: agentId, scope, ttl_days: ttlDays } }),
  /** 解除撤銷（admin）：讓被撤銷的 agent 名稱可再次綁定。 */
  unrevokeAgent: (id: string) =>
    request<void>("POST", `/v1/agents/${encodeURIComponent(id)}/authorization`),

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
/** 事件與會者（含回覆狀態）。 */
export interface EventParticipant {
  member_id: string | null;
  guest_email: string | null;
  display_name: string | null;
  email: string | null;
  /** pending=已邀請待回覆、accepted=已接受、declined=已婉拒 */
  rsvp_status: string;
  is_organizer: boolean;
}

export interface WorkspaceMember {
  membership_id: string;
  user_id: string;
  display_name: string;
  role: string;
}
