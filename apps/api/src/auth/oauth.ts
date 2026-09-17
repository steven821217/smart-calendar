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
/** access token 預設壽命（agent M2M）。 */
const DEFAULT_TOKEN_TTL_SEC = Number(process.env.OAUTH_TOKEN_TTL_SEC ?? 3600);

interface CodeRecord {
  workspace: string;
  user_sub: string; // 授權的使用者（membership id）
  agent_id: string;
  scope: AgentScopeT[];
  roles: string[]; // agent 能力上限的角色基底（取授權者角色）
  code_challenge: string;
  code_challenge_method: "S256";
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
}): Promise<{ code: string; expires_in: number }> {
  if (params.scope.length === 0) {
    throw new OAuthError("invalid_scope", "at least one scope required");
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
  // 發 scoped M2M token：sub=agent_id、workspace/roles 取授權者、scope=consent 勾選
  const access_token = signJwt(
    { sub: rec.agent_id, workspace: rec.workspace, roles: rec.roles, scope: rec.scope, user_sub: rec.user_sub },
    ttl,
  );
  return {
    access_token,
    token_type: "Bearer",
    expires_in: ttl,
    scope: rec.scope.join(" "),
  };
}
