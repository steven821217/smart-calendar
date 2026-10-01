import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { isAllowedRedirectUri, s256Challenge } from "../src/auth/oauth.js";

/**
 * OAuth 2.1 自動發現（MCP 授權規範）。
 *
 * 鎖住的性質：
 *  1. discovery metadata 可匿名讀取，且內容指向正確端點（RFC 9728 / RFC 8414）。
 *  2. redirect_uri 白名單——**最關鍵的控制**。放行任意 redirect_uri＝把授權碼送給
 *     攻擊者。只允許 loopback 與站台白名單的 https；且不合法時**不得導回**該 URI。
 *  3. /authorize 強制 response_type=code 與 PKCE S256，錯誤以標準 error 參數導回。
 *  4. 授權碼綁定 redirect_uri：換 token 時不符即 invalid_grant。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "demo-password-1234";
const CLIENT = "disco-test-client";
const REDIRECT = "http://127.0.0.1:53210/callback";

beforeAll(async () => {
  process.env.LOGIN_THROTTLE = "0";
  process.env.OAUTH_REDIRECT_ALLOWLIST = "https://claude.ai/api/mcp/auth_callback";
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const login = async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "a@example.com", password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().access_token as string;
};

describe("discovery metadata（匿名可讀）", () => {
  it("/.well-known/oauth-protected-resource 指向 MCP 端點與授權伺服器", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(res.statusCode).toBe(200); // 無 token 也要能讀
    const b = res.json();
    expect(b.resource).toMatch(/\/mcp$/);
    expect(Array.isArray(b.authorization_servers)).toBe(true);
    expect(b.scopes_supported).toContain("availability.read");
    expect(b.bearer_methods_supported).toEqual(["header"]);
  });

  it("/.well-known/oauth-authorization-server 宣告 PKCE S256 與端點", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.authorization_endpoint).toMatch(/\/v1\/oauth\/authorize$/);
    expect(b.token_endpoint).toMatch(/\/v1\/oauth\/token$/);
    expect(b.code_challenge_methods_supported).toEqual(["S256"]); // 不得提供 plain
    expect(b.response_types_supported).toEqual(["code"]);
    expect(b.grant_types_supported).toEqual(["authorization_code"]);
  });

  it("openid-configuration 別名同樣可讀（部分 client 只找這個路徑）", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorization_endpoint).toBeTruthy();
  });
});

describe("redirect_uri 白名單（最關鍵的控制）", () => {
  it("允許 loopback（桌面/CLI client 的標準做法）", () => {
    expect(isAllowedRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:8080/oauth/callback")).toBe(true);
  });

  it("拒絕任意外部網址（防授權碼外流／open redirect）", () => {
    expect(isAllowedRedirectUri("https://evil.example.com/steal")).toBe(false);
    expect(isAllowedRedirectUri("http://evil.example.com/steal")).toBe(false); // 非 loopback 的 http
    expect(isAllowedRedirectUri("http://127.0.0.1.evil.com/cb")).toBe(false); // 相似域名混淆
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("not-a-url")).toBe(false);
  });

  it("拒絕帶 fragment 的 redirect_uri（OAuth 2.1 明文禁止）", () => {
    expect(isAllowedRedirectUri("http://127.0.0.1:1234/cb#x")).toBe(false);
  });

  it("允許白名單內的 https（OAUTH_REDIRECT_ALLOWLIST）", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback?x=1")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai/other")).toBe(false);
  });
});

describe("GET /v1/oauth/authorize", () => {
  const authorize = (q: Record<string, string>) =>
    app.inject({ method: "GET", url: `/v1/oauth/authorize?${new URLSearchParams(q).toString()}` });

  it("合法請求 → 302 導到站內同意頁，並帶齊參數", async () => {
    const res = await authorize({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: "availability.read event.read",
      state: "st-123",
      code_challenge: s256Challenge("verifier-".padEnd(50, "x")),
      code_challenge_method: "S256",
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain("#/oauth/consent");
    expect(loc).toContain(`client_id=${CLIENT}`);
    expect(loc).toContain("state=st-123");
    expect(decodeURIComponent(loc)).toContain(REDIRECT);
  });

  it("不合法的 redirect_uri → 400，且**不導回**（避免 open redirect）", async () => {
    const res = await authorize({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: "https://evil.example.com/steal",
      code_challenge: s256Challenge("v".padEnd(50, "x")),
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it("缺 PKCE / 用 plain → 以 invalid_request 導回（含 state）", async () => {
    const noPkce = await authorize({ response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, state: "s1" });
    expect(noPkce.statusCode).toBe(302);
    expect(noPkce.headers.location).toContain("error=invalid_request");
    expect(noPkce.headers.location).toContain("state=s1");

    const plain = await authorize({
      response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT,
      code_challenge: "abc", code_challenge_method: "plain",
    });
    expect(plain.headers.location).toContain("error=invalid_request");
  });

  it("response_type 非 code → unsupported_response_type", async () => {
    const res = await authorize({
      response_type: "token", client_id: CLIENT, redirect_uri: REDIRECT,
      code_challenge: s256Challenge("v".padEnd(50, "x")),
    });
    expect(res.headers.location).toContain("error=unsupported_response_type");
  });

  it("未知 scope → invalid_scope", async () => {
    const res = await authorize({
      response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, scope: "god.mode",
      code_challenge: s256Challenge("v".padEnd(50, "x")),
    });
    expect(res.headers.location).toContain("error=invalid_scope");
  });
});

describe("授權碼綁定 redirect_uri", () => {
  it("換 token 時 redirect_uri 不符 → invalid_grant", async () => {
    const userToken = await login();
    const verifier = crypto.randomBytes(48).toString("base64url");
    const consent = await app.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        agent_id: CLIENT,
        scope: ["availability.read"],
        code_challenge: s256Challenge(verifier),
        code_challenge_method: "S256",
        redirect_uri: REDIRECT,
        client_id: CLIENT,
      },
    });
    expect(consent.statusCode).toBe(201);
    const code = consent.json().authorization_code as string;

    const wrong = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        agent_id: CLIENT,
        redirect_uri: "http://127.0.0.1:9999/other",
      },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("invalid_grant");
  });

  it("redirect_uri 相符 → 發出 token，且 aud 記錄 resource（RFC 8707）", async () => {
    const userToken = await login();
    const verifier = crypto.randomBytes(48).toString("base64url");
    const resource = "https://127.0.0.1:9443/mcp";
    const consent = await app.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        agent_id: CLIENT,
        scope: ["availability.read"],
        code_challenge: s256Challenge(verifier),
        code_challenge_method: "S256",
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        resource,
      },
    });
    const code = consent.json().authorization_code as string;
    const ok = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        agent_id: CLIENT,
        redirect_uri: REDIRECT,
      },
    });
    expect(ok.statusCode).toBe(200);
    const token = ok.json().access_token as string;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    expect(claims.aud).toBe(resource);
    expect(claims.scope).toEqual(["availability.read"]);
  });

  it("consent 帶不合法 redirect_uri → 400（不發授權碼）", async () => {
    const userToken = await login();
    const res = await app.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        agent_id: CLIENT,
        scope: ["availability.read"],
        code_challenge: s256Challenge("v".padEnd(50, "x")),
        code_challenge_method: "S256",
        redirect_uri: "https://evil.example.com/steal",
        client_id: CLIENT,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PoC 取捨：長效 access token + 即時撤銷（不做 refresh token）", () => {
  it("metadata 誠實宣告 token 壽命（供同意頁顯示），且為多天而非 1 小時", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    const days = res.json().scal_access_token_lifetime_days as number;
    expect(typeof days).toBe("number");
    expect(days).toBeGreaterThanOrEqual(1);
  });

  it("發出的 token expires_in 與設定一致（不再是 3600）", async () => {
    const userToken = await login();
    const verifier = crypto.randomBytes(48).toString("base64url");
    const consent = await app.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        agent_id: CLIENT,
        scope: ["availability.read"],
        code_challenge: s256Challenge(verifier),
        code_challenge_method: "S256",
        redirect_uri: REDIRECT,
        client_id: CLIENT,
      },
    });
    const code = consent.json().authorization_code as string;
    const ok = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "authorization_code", code, code_verifier: verifier,
        agent_id: CLIENT, redirect_uri: REDIRECT,
      },
    });
    expect(ok.statusCode).toBe(200);
    const expiresIn = ok.json().expires_in as number;
    expect(expiresIn).toBe(Number(process.env.OAUTH_TOKEN_TTL_SEC ?? 30 * 86400));
    expect(expiresIn).toBeGreaterThan(3600); // 長效：避免 PoC 每小時重新授權
    // 長效可接受的前提：token 帶 scope → guardTool 必定查撤銷黑名單
    const claims = JSON.parse(Buffer.from((ok.json().access_token as string).split(".")[1], "base64").toString("utf8"));
    expect(Array.isArray(claims.scope) && claims.scope.length > 0).toBe(true);
  });
});
