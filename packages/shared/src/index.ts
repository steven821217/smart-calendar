import { z } from "zod";

export * from "./nlp.js";

export const Visibility = z.enum(["public", "busy", "private"]);
export const EventKind = z.enum(["single", "master", "exception"]);
export const EventSource = z.enum(["app", "agent", "google", "m365"]);

// 參與者：內部 member 或外部 guest 至少一
export const ParticipantInput = z
  .object({
    member_id: z.string().uuid().optional(),
    guest_email: z.string().email().optional(),
    is_organizer: z.boolean().default(false),
  })
  .refine((p) => p.member_id || p.guest_email, {
    message: "member_id or guest_email required",
  });

/**
 * ParticipantsInput：取代某事件的與會者名單（PUT /v1/events/:id/participants）。
 * 空陣列＝只剩發起人（發起人一律保留，不可移除）。
 */
export const ParticipantsInput = z.object({
  member_ids: z.array(z.string().uuid()).max(100).default([]),
  guest_emails: z.array(z.string().email().max(320)).max(100).default([]),
});
export type ParticipantsInputT = z.infer<typeof ParticipantsInput>;

// EventInput：建立事件 request（無 workspace_id，脈絡來自 JWT — ISO-3）
/**
 * 人類可見的名稱／標題欄位。
 *
 * 為何需要這個而不是 `z.string().min(1)`：zod 驗的是**未 trim** 的原字串，
 * 所以純空白（如 "   "）長度 3 會通過 min(1)，等到 handler 才 trim 成空字串，
 * 結果建出無名的 workspace／事件／群組。實測確認過：帶 workspace_name="   "
 * 註冊會回 201 並產生名稱為 "   " 的 workspace。
 *
 * 因此先 transform(trim) 再 refine 非空，讓驗證層就擋掉。
 */
export const nonBlankText = (max: number, label = "此欄位") =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, `${label}不可為空`);

export const EventInput = z
  .object({
    calendar_id: z.string().uuid(),
    title: nonBlankText(300, "標題"),
    description: z.string().nullish(),
    start_utc: z.string().datetime(),
    end_utc: z.string().datetime(),
    timezone: z.string().min(1), // IANA
    rrule: z.string().nullish(), // RFC 5545；null=單次
    rdate: z.array(z.string().datetime()).optional(),
    exdate: z.array(z.string().datetime()).optional(),
    visibility: Visibility.default("busy"),
    location: z.string().nullish(),
    participants: z.array(ParticipantInput).optional(),
  })
  .refine((e) => new Date(e.end_utc) > new Date(e.start_utc), {
    message: "end_utc must be after start_utc",
    path: ["end_utc"],
  });

export const Occurrence = z.object({
  event_id: z.string().uuid(),
  occurrence_start_utc: z.string().datetime(),
  occurrence_end_utc: z.string().datetime(),
  title: z.string(),
  timezone: z.string(),
  kind: z.enum(["master_instance", "exception"]),
  is_exception: z.boolean(),
  exception_id: z.string().uuid().nullable(),
});

// RFC 7807 problem+json
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
});

// ResourceInput：建立資源 request（無 workspace_id，脈絡來自 JWT — ISO-3）
export const ResourceInput = z.object({
  name: nonBlankText(200, "名稱"),
  type: z.enum(["room", "equipment"]).default("room"),
  capacity: z.number().int().positive().nullish(),
});

// BookingInput：資源預訂 request（防雙訂於 DB EXCLUDE 兜底 — REQ-R2）
export const BookingInput = z
  .object({
    event_id: z.string().uuid(),
    start_utc: z.string().datetime(),
    end_utc: z.string().datetime(),
  })
  .refine((b) => new Date(b.end_utc) > new Date(b.start_utc), {
    message: "end_utc must be after start_utc",
    path: ["end_utc"],
  });

// ReminderInput：設定會前 N 分鐘提醒（api.md ReminderInput）
export const ReminderInput = z.object({
  lead_minutes: z.number().int().min(0),
  member_id: z.string().uuid().nullish(),
  channel: z.enum(["email", "push", "webhook"]).default("email"),
});

// WebhookInput：註冊事件生命週期 webhook（REQ-N3）
export const WebhookInput = z.object({
  url: z.string().url(),
  events: z
    .array(
      z.enum([
        "*",
        "event.created",
        "event.updated",
        "event.deleted",
        "resource.booked",
        "resource.booking_cancelled",
        "scheduling.needs_decision",
        "scheduling.rsvp_pending",
      ]),
    )
    .min(1),
  secret: z.string().min(16).max(200).optional(), // 省略則後端產生
});
export type WebhookInputT = z.infer<typeof WebhookInput>;

export type EventInputT = z.infer<typeof EventInput>;
export type OccurrenceT = z.infer<typeof Occurrence>;
export type ProblemT = z.infer<typeof Problem>;
export type ResourceInputT = z.infer<typeof ResourceInput>;
export type BookingInputT = z.infer<typeof BookingInput>;
export type ReminderInputT = z.infer<typeof ReminderInput>;

// ---------------------------------------------------------------------------
// OAuth 2.1 consent（mcp.md §3 / 8.3）：使用者授權外部 AI agent 代其操作日曆。
// 授權範圍 = MCP tool 所需 scope 的集合；consent 預設只勾唯讀（最小授權）。
// ---------------------------------------------------------------------------

/** 可被授權給 agent 的 OAuth scope（對齊 mcp/guard.ts TOOL_SCOPE）。 */
export const AgentScope = z.enum([
  "availability.read",
  "event.read",
  "event.write",
  "resource.book",
]);
export type AgentScopeT = z.infer<typeof AgentScope>;

/** 唯讀 scope 集合：consent 預設只勾這些（最小授權，mcp.md §3）。 */
export const READONLY_SCOPES: AgentScopeT[] = ["availability.read", "event.read"];

/** 寫入類 scope：需使用者明確加勾。 */
export const WRITE_SCOPES: AgentScopeT[] = ["event.write", "resource.book"];

/**
 * ConsentInput：使用者（已登入）授權某 agent 的請求。
 * PKCE：agent 端產 code_verifier，送其 S256 challenge；換 token 時附 verifier 驗證。
 */
export const ConsentInput = z.object({
  agent_id: z.string().min(1).max(200),
  scope: z.array(AgentScope).min(1),
  code_challenge: z.string().min(43).max(128), // PKCE S256 base64url
  code_challenge_method: z.literal("S256").default("S256"),
  ttl_seconds: z.number().int().min(60).max(3600).optional(), // 發出的 access token 壽命
  /** 以下為 OAuth 2.1 導向流程（/v1/oauth/authorize → 同意頁）帶入，授權碼會綁定它們。 */
  redirect_uri: z.string().url().max(2000).optional(),
  client_id: z.string().min(1).max(200).optional(),
  resource: z.string().url().max(2000).optional(),
});
export type ConsentInputT = z.infer<typeof ConsentInput>;

/** TokenInput：agent 用 authorization_code + PKCE verifier 換 access token。 */
export const TokenInput = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
  agent_id: z.string().min(1).max(200),
  /** 導向流程必須帶，且需與授權時登記的完全一致。 */
  redirect_uri: z.string().url().max(2000).optional(),
});
export type TokenInputT = z.infer<typeof TokenInput>;

/**
 * RegisterInput：自助註冊（3.1）。
 *
 * 語意：註冊會建立**一個新的 workspace**，註冊者成為該 workspace 的 admin
 *（加入「既有」workspace 需邀請流程，尚未實作）。email 全域唯一。
 */
export const RegisterInput = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8, "密碼至少 8 個字元").max(200),
  display_name: nonBlankText(120, "顯示名稱"),
  workspace_name: nonBlankText(120, "工作區名稱"),
  /** 觀看者時區（前端可帶瀏覽器時區）；非法值由後端退回 UTC。 */
  timezone: z.string().min(1).max(64).optional(),
});
export type RegisterInputT = z.infer<typeof RegisterInput>;

/**
 * CreateWorkspaceInput：已登入的人再建立一個 workspace（3.1b）。
 *
 * 與 RegisterInput 的差別：不建立新使用者，只在同一個帳號下多開一個 workspace，
 * 建立者為該 workspace 的 admin。用途是同一個人分開管理不同情境
 *（例如「公司」與「家庭」），彼此資料以 RLS 完全隔離。
 */
export const CreateWorkspaceInput = z.object({
  name: nonBlankText(120, "工作區名稱"),
  /** 觀看者時區（前端可帶瀏覽器時區）；非法值由後端退回建立者現有的時區。 */
  timezone: z.string().min(1).max(64).optional(),
});
export type CreateWorkspaceInputT = z.infer<typeof CreateWorkspaceInput>;

/**
 * InviteMemberInput：邀請新成員加入既有的 workspace。
 */
export const InviteMemberInput = z.object({
  email: z.string().email().max(320),
  role: z.enum(["admin", "scheduler", "member", "guest"]).default("member"),
  display_name: nonBlankText(120, "顯示名稱").optional(),
});
export type InviteMemberInputT = z.infer<typeof InviteMemberInput>;

/**
 * AgentTokenInput：使用者在站內「綁定一個外部 agent 到自己的帳號」。
 *
 * 為何需要這條路徑（而非只有 PKCE consent）：實務上的 MCP client（Claude Code /
 * OpenCode / OpenClaw…）是在設定檔填一組靜態 `Authorization: Bearer <token>`，
 * 不會實作 OAuth 導向或 device code 流程。因此提供「登入的人在 UI 勾 scope →
 * 產生一組短期、可撤銷的 scoped token → 貼進 agent 設定」的綁定方式。
 *
 * 安全邊界：發出的 token 以簽發者為 on-behalf-of，roles 直接沿用簽發者
 *（不可提權）、scope 為使用者勾選的子集、有到期日、可經 agent 撤銷即時失效。
 */
export const AgentTokenInput = z.object({
  agent_id: z.string().min(1).max(200).describe("agent 識別名稱，如 claude-desktop"),
  scope: z.array(AgentScope).min(1),
  ttl_days: z.number().int().min(1).max(90).default(30).describe("token 有效天數（上限 90）"),
});
export type AgentTokenInputT = z.infer<typeof AgentTokenInput>;

