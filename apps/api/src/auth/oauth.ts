import crypto from "node:crypto";
import Redis from "ioredis";
import { signJwt } from "./jwt.js";
import type { AgentScopeT } from "@scal/shared";

/**
 * OAuth 2.1 consent（mcp.md §3 / 8.3）— 最小可行、無旁路實作。
 *
 * 流程（Authorization Code + PKCE，S256）：
 *   1) 使用者（已登入，帶 user JWT）呼叫 /v1/oauth/consent 勾選要授權給某 agent 的 scope
 *      → 產生一次性、短效 authorization_code，綁 { workspace, user, agent, scope, code_challenge }。
 *   2) agent 呼叫 /v1/oauth/token 帶 code + code_verifier + agent_id
 *      → 驗 PKCE（S256(verifier)===challenge）、驗 code 未用過/未過期 → 發 scoped M2M token。
 *   3) MCP HTTP server 吃該 token（sub=agent_id, workspace, scope）→ guardTool 依 scope∩role 授權。
 *
 * 設計對齊既有模型：無獨立 grant 表，授權碼以 Redis 存（一次性、短 TTL）；撤銷仍走
 * agents/service.ts 的 Redis 黑名單（MCP-8）。發出的 token 就是既有 signJwt 的 M2M token。
 */

const redis = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

/** authorization_code TTL：短效（RFC 建議 ≤10 分）。 */
const CODE_TTL_SEC = Number(process.env.OAUTH_CODE_TTL_SEC ?? 300);
/**
 * access token 預設壽命（agent M2M）。
 *
 * PoC 取捨：**不實作 refresh token**，改把 token 壽命拉長（預設 30 天），以免使用者
 * 每小時就要重新授權一次。可接受的理由是撤銷是即時的——`mcp/guard.ts` 每次 tool
 * 呼叫都查 Redis 黑名單（`isAgentRevoked`），而本流程發出的 token 一定帶 scope，
 * 必然經過該檢查。因此風險由「洩漏後無法收回」降為「可隨時到『我的 AI agent』撤銷」。
 *
 * 正式環境仍應改為短效 access token + refresh token 輪替（見 README 尚未實作）。
 */
const DEFAULT_TOKEN_TTL_SEC = Number(process.env.OAUTH_TOKEN_TTL_SEC ?? 30 * 86_400);
/** 供 UI 誠實顯示「這次授權會維持多久」。 */
export const tokenLifetimeDays = () => Math.round(DEFAULT_TOKEN_TTL_SEC / 86_400);

interface CodeRecord {
  workspace: string;
  user_sub: string; // 授權的使用者（membership id）
  agent_id: string;
  scope: AgentScopeT[];
  roles: string[]; // agent 能力上限的角色基底（取授權者角色）
  code_challenge: string;
  code_challenge_method: "S256";
  /** OAuth 2.1 導向流程用：授權碼必須綁定 client 與 redirect_uri，換 token 時逐一核對。 */
  redirect_uri?: string;
  client_id?: string;
  /** RFC 8707：此 token 的目標資源（MCP server）。 */
  resource?: string;
}

/**
 * redirect_uri 白名單檢核（OAuth 2.1 最關鍵的控制）。
 *
 * 只允許：
 *  1. loopback（http://127.0.0.1[:port]/… 或 http://localhost[:port]/…）——桌面／CLI
 *     型 MCP client 的標準做法（RFC 8252）。
 *  2. OAUTH_REDIRECT_ALLOWLIST 逐一列出的 https 前綴（逗號分隔）。
 *
 * 其餘一律拒絕：放行任意 redirect_uri 等於把授權碼送給攻擊者（open redirect →
 * 帳號接管）。注意呼叫端在 redirect_uri 不合法時**不得**導回該 URI，只能顯示錯誤。
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // 不接受帶 fragment 的 redirect_uri（OAuth 2.1 明文禁止）
  if (u.hash) return false;
  if (u.protocol === "http:") {
    const host = u.hostname;
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    return isLoopback;
  }
  if (u.protocol !== "https:") return false; // 自訂 scheme 暫不支援
  const allow = (process.env.OAUTH_REDIRECT_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.some((prefix) => raw === prefix || raw.startsWith(prefix));
}

function codeKey(code: string) {
  return `oauth:code:${code}`;
}

/** base64url(SHA256(verifier)) —— PKCE S256 challenge 計算。 */
export function s256Challenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export class OAuthError extends Error {
  constructor(
    public code:
      | "invalid_request"
      | "invalid_grant"
      | "invalid_scope"
      | "access_denied"
      | "server_error",
    msg: string,
  ) {
    super(msg);
    this.name = "OAuthError";
  }
}

/**
 * 建立授權碼（consent 步驟）。呼叫者必須是已驗證的使用者，workspace/roles 來自其 token。
 * 回傳一次性 code（agent 之後用它換 token）。
 */
export async function issueAuthorizationCode(params: {
  workspace: string;
  user_sub: string;
  roles: string[];
  agent_id: string;
  scope: AgentScopeT[];
  code_challenge: string;
  code_challenge_method: "S256";
  redirect_uri?: string;
  client_id?: string;
  resource?: string;
}): Promise<{ code: string; expires_in: number }> {
  if (params.scope.length === 0) {
    throw new OAuthError("invalid_scope", "at least one scope required");
  }
  // 導向流程：redirect_uri 必須先過白名單才可寫入授權碼
  if (params.redirect_uri && !isAllowedRedirectUri(params.redirect_uri)) {
    throw new OAuthError("invalid_request", "redirect_uri not allowed");
  }
  const code = crypto.randomBytes(32).toString("base64url");
  const record: CodeRecord = {
    workspace: params.workspace,
    user_sub: params.user_sub,
    agent_id: params.agent_id,
    scope: params.scope,
    roles: params.roles,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    redirect_uri: params.redirect_uri,
    client_id: params.client_id,
    resource: params.resource,
  };
  await redis.set(codeKey(code), JSON.stringify(record), "EX", CODE_TTL_SEC);
  return { code, expires_in: CODE_TTL_SEC };
}

/**
 * 用授權碼換 access token（token 步驟）。一次性：成功即刪除 code（防 replay）。
 * PKCE：S256(code_verifier) 必須等於 consent 當時登記的 code_challenge。
 * agent_id 必須與 code 綁定者一致。
 */
export async function exchangeCodeForToken(params: {
  code: string;
  code_verifier: string;
  agent_id: string;
  /** 導向流程必填：必須與授權時登記的完全一致（防授權碼被換到別的 client）。 */
  redirect_uri?: string;
}): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; scope: string }> {
  const raw = await redis.get(codeKey(params.code));
  if (!raw) throw new OAuthError("invalid_grant", "authorization code invalid or expired");

  // 一次性：先刪除（即使後續驗證失敗也不可重用此 code）
  await redis.del(codeKey(params.code));

  let rec: CodeRecord;
  try {
    rec = JSON.parse(raw) as CodeRecord;
  } catch {
    throw new OAuthError("server_error", "corrupt code record");
  }

  if (rec.agent_id !== params.agent_id) {
    throw new OAuthError("invalid_grant", "agent_id does not match authorization");
  }
  // redirect_uri 必須與授權時登記者完全相同（OAuth 2.1）。
  // 授權碼是在導向流程發出的（有登記 redirect_uri）→ 換 token 時必須帶且相符。
  if (rec.redirect_uri && rec.redirect_uri !== params.redirect_uri) {
    throw new OAuthError("invalid_grant", "redirect_uri mismatch");
  }
  // PKCE 驗證（S256）
  const expected = rec.code_challenge;
  const actual = s256Challenge(params.code_verifier);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  ) {
    throw new OAuthError("invalid_grant", "PKCE verification failed");
  }

  const ttl = DEFAULT_TOKEN_TTL_SEC;
  // 發 scoped M2M token：sub=agent_id、workspace/roles 取授權者、scope=consent 勾選。
  // aud（RFC 8707）：導向流程若帶了 resource，就把它記進 token，供資源伺服器核對
  // 「這張 token 是發給我的」。舊有的貼 token 流程不帶 aud（向後相容）。
  const access_token = signJwt(
    {
      sub: rec.agent_id,
      workspace: rec.workspace,
      roles: rec.roles,
      scope: rec.scope,
      user_sub: rec.user_sub,
      ...(rec.resource ? { aud: rec.resource } : {}),
    },
    ttl,
  );
  return {
    access_token,
    token_type: "Bearer",
    expires_in: ttl,
    scope: rec.scope.join(" "),
  };
}
