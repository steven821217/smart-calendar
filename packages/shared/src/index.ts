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

// EventInput：建立事件 request（無 workspace_id，脈絡來自 JWT — ISO-3）
export const EventInput = z
  .object({
    calendar_id: z.string().uuid(),
    title: z.string().min(1).max(300),
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
  name: z.string().min(1).max(200),
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
});
export type ConsentInputT = z.infer<typeof ConsentInput>;

/** TokenInput：agent 用 authorization_code + PKCE verifier 換 access token。 */
export const TokenInput = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
  agent_id: z.string().min(1).max(200),
});
export type TokenInputT = z.infer<typeof TokenInput>;

