import crypto from "node:crypto";

export interface AuthContext {
  sub: string;
  workspace: string;
  roles: string[];
  scope?: string[]; // agent M2M token 用
  user_sub?: string; // M2M token：授權該 agent 的使用者 membership id（on-behalf-of）
}

const SECRET = process.env.JWT_SECRET ?? "change-me-32bytes-minimum-secret-value";

/** 一般使用者 access token 有效期：1 小時。OAuth/agent/action token 另有各自 TTL。 */
export const USER_ACCESS_TOKEN_TTL_SEC = 60 * 60;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 簽發 HS256 JWT（本機用；正式改 RS256/JWKS） */
export function signJwt(
  payload: Record<string, unknown>,
  expiresInSec = USER_ACCESS_TOKEN_TTL_SEC,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

/** 驗證 JWT 並取出 AuthContext。失敗回 null。workspace 脈絡僅來自 token（ISO-3）。 */
export function verifyJwt(authHeader?: string): AuthContext | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest());
  // 定長比較，防 timing attack
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (!claims.sub || !claims.workspace) return null;
  return {
    sub: String(claims.sub),
    workspace: String(claims.workspace),
    roles: Array.isArray(claims.roles) ? (claims.roles as string[]) : [],
    scope: Array.isArray(claims.scope) ? (claims.scope as string[]) : undefined,
    user_sub: claims.user_sub ? String(claims.user_sub) : undefined,
  };
}
