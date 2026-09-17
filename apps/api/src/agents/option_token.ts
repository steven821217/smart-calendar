import crypto from "node:crypto";

/**
 * 談判選項一鍵確認（延伸 C / X.1）。
 *
 * needs_decision 的每個 option 帶一個簽章 option_token（HS256），內含
 * workspace/attendees/resource/slot + 短 TTL。人類選定後 re-call confirm=true + option_token
 * 即可直接落實，免重跑整個圖（降低延遲與 LLM 成本）。
 *
 * 安全：token 由後端簽章 → 竄改（改 slot/resource/workspace）即驗章失敗；
 * workspace 亦在落實時以 ctx.workspace 再核對（ZT-5），token 不能跨 workspace 使用。
 */

const SECRET = process.env.JWT_SECRET ?? "change-me-32bytes-minimum-secret-value";
const DEFAULT_TTL_SEC = 900; // 15 分鐘

export interface OptionClaims {
  workspace: string;
  calendar_id: string;
  attendees: string[];
  resource_id: string;
  needs_handover: boolean;
  // 實際使用時段
  actual_start_utc: string;
  actual_end_utc: string;
  // 含 buffer 的寫入時段
  booking_start_utc: string;
  booking_end_utc: string;
  title: string;
  timezone: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signOptionToken(claims: OptionClaims, ttlSec = DEFAULT_TTL_SEC): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...claims, iat: now, exp: now + ttlSec };
  const p = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(p).digest());
  return `${p}.${sig}`;
}

export class OptionTokenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OptionTokenError";
  }
}

/** 驗章 + 過期檢查 + workspace 綁定核對。失敗丟 OptionTokenError。 */
export function verifyOptionToken(token: string, expectedWorkspace: string): OptionClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw new OptionTokenError("malformed option_token");
  const [p, sig] = parts;
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(p).digest());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new OptionTokenError("invalid option_token signature");
  }
  let claims: OptionClaims & { exp?: number };
  try {
    claims = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    throw new OptionTokenError("undecodable option_token");
  }
  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
    throw new OptionTokenError("expired option_token");
  }
  // ZT-5：token 的 workspace 必須等於呼叫者 token 的 workspace，杜絕跨 workspace 重放
  if (claims.workspace !== expectedWorkspace) {
    throw new OptionTokenError("option_token workspace mismatch");
  }
  return claims;
}

// ---------------------------------------------------------------------------
// RSVP token（feature-team-groups Req 3.1）：委員會幫 Member 建 pending 事件後，
// 為該 Member 產生專屬 option_token。Member 憑此 token 對 POST /v1/events/:id/rsvp
// 進行 accept/decline，免登入即可一鍵回覆（模擬 Member 端跳出通知）。
// 復用相同 HMAC(HS256) 簽章與 b64url payload；claims 綁 workspace/event/member（ZT-5）。
// ---------------------------------------------------------------------------

export interface RsvpClaims {
  kind: "rsvp";
  workspace: string;
  event_id: string;
  member_id: string; // 被邀請 member 的 membership_id
}

const RSVP_TTL_SEC = 7 * 24 * 3600; // 7 天：任務邀請通常給較長回覆期

export function signRsvpToken(claims: RsvpClaims, ttlSec = RSVP_TTL_SEC): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...claims, iat: now, exp: now + ttlSec };
  const p = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(p).digest());
  return `${p}.${sig}`;
}

/**
 * 驗 RSVP token。與 verifyOptionToken 同一驗章路徑，但額外檢查 kind==='rsvp'
 * 與 event_id/member_id 綁定，並可選擇性核對 workspace（RSVP 端點無登入 → 由 token 自帶）。
 */
export function verifyRsvpToken(token: string, expectedWorkspace?: string): RsvpClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw new OptionTokenError("malformed rsvp_token");
  const [p, sig] = parts;
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(p).digest());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new OptionTokenError("invalid rsvp_token signature");
  }
  let claims: RsvpClaims & { exp?: number };
  try {
    claims = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    throw new OptionTokenError("undecodable rsvp_token");
  }
  if (claims.kind !== "rsvp") throw new OptionTokenError("not an rsvp_token");
  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
    throw new OptionTokenError("expired rsvp_token");
  }
  if (!claims.event_id || !claims.member_id || !claims.workspace) {
    throw new OptionTokenError("incomplete rsvp_token");
  }
  if (expectedWorkspace && claims.workspace !== expectedWorkspace) {
    throw new OptionTokenError("rsvp_token workspace mismatch");
  }
  return claims;
}
