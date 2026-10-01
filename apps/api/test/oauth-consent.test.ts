import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/server.js";
import { buildHttpServer } from "../src/mcp/http.js";
import { s256Challenge } from "../src/auth/oauth.js";

/**
 * OAuth 2.1 consent 端到端閉環（mcp.md §3）：
 *   使用者 login → /v1/oauth/consent（勾 scope + PKCE challenge）→ authorization_code
 *   → agent /v1/oauth/token（code + verifier）→ scoped access token
 *   → 帶該 token 連 MCP Streamable HTTP → 實際呼叫 tool（授權鏈以 token 的 scope 生效）。
 * 這證明「使用者按同意授權、agent 代表使用者操作日曆」的正式流程可運作。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let api: ReturnType<typeof buildServer>;
let mcp: Server;
let mcpUrl: string;

beforeAll(async () => {
  process.env.MCP_STUB_MODEL = "1";
  const admin = adminClient();
  await admin.connect();
  const mem = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=(SELECT id FROM workspaces WHERE slug='ws-a') LIMIT 1`)).rows[0].id;
  process.env.MCP_STUB_MEMBER_ID = mem;
  await admin.end();

  api = buildServer();
  await api.ready();

  mcp = buildHttpServer();
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  const addr = mcp.address();
  mcpUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`;
});

afterAll(async () => {
  await api.close();
  await new Promise<void>((resolve) => mcp.close(() => resolve()));
});

/** 使用者登入取 user JWT。 */
async function login(email = "a@example.com"): Promise<string> {
  const password = process.env.SEED_DEMO_PASSWORD ?? "demo-password-1234";
  const res = await api.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json().access_token as string;
}

describe("OAuth 2.1 consent flow", () => {
  it("完整閉環：consent → token → 帶 token 用 MCP 呼叫 tool", async () => {
    const userToken = await login();

    // agent 端產 PKCE
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = s256Challenge(verifier);
    const agentId = "agent-oauth-e2e";

    // 1) 使用者授權（勾唯讀 + 寫入 + 訂資源）
    const consent = await api.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        agent_id: agentId,
        scope: ["availability.read", "event.write", "resource.book"],
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
    });
    expect(consent.statusCode).toBe(201);
    const code = consent.json().authorization_code as string;
    expect(code).toBeTruthy();

    // 2) agent 換 token
    const tokenRes = await api.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: { grant_type: "authorization_code", code, code_verifier: verifier, agent_id: agentId },
    });
    expect(tokenRes.statusCode).toBe(200);
    const { access_token, scope } = tokenRes.json();
    expect(scope).toContain("resource.book");

    // 3) 帶 scoped token 連 MCP HTTP，實際呼叫 tool
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    });
    const client = new Client({ name: "oauth-e2e", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(10);
      // OAuth 發出的 M2M token：sub=agent_id、user_sub=授權者。agent 應能查到
      // 自己「代表誰」在操作（過去無此能力，只能自行解碼 JWT 拿到一串 UUID）。
      const who = await client.callTool({ name: "whoami", arguments: {} });
      const whoPayload = JSON.parse((who as { content: Array<{ text: string }> }).content[0].text);
      expect(whoPayload.actor_type).toBe("agent");
      expect(whoPayload.agent_id).toBe(agentId);
      // on_behalf_of 必須是「實際做 consent 的那個人」（userToken 的 sub），
      // 而不是 workspace 裡任何一個 membership。
      const consentingMember = JSON.parse(
        Buffer.from(userToken.split(".")[1], "base64").toString("utf8"),
      ).sub as string;
      expect(whoPayload.on_behalf_of.membership_id).toBe(consentingMember);
      expect(whoPayload.capabilities.destructive_actions).toBe(false);
      const res = await client.callTool({
        name: "find_available_time_slots",
        arguments: { from_utc: "2027-12-01T00:00:00Z", to_utc: "2027-12-01T04:00:00Z", duration_minutes: 30, busy: [] },
      });
      const payload = JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
      expect(Array.isArray(payload.slots)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("授權碼一次性：重用同一 code → invalid_grant", async () => {
    const userToken = await login();
    const verifier = crypto.randomBytes(48).toString("base64url");
    const agentId = "agent-oauth-replay";
    const consent = await api.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { agent_id: agentId, scope: ["availability.read"], code_challenge: s256Challenge(verifier), code_challenge_method: "S256" },
    });
    const code = consent.json().authorization_code as string;
    const first = await api.inject({ method: "POST", url: "/v1/oauth/token", payload: { grant_type: "authorization_code", code, code_verifier: verifier, agent_id: agentId } });
    expect(first.statusCode).toBe(200);
    const second = await api.inject({ method: "POST", url: "/v1/oauth/token", payload: { grant_type: "authorization_code", code, code_verifier: verifier, agent_id: agentId } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("invalid_grant");
  });

  it("PKCE 錯誤：verifier 不符 → invalid_grant", async () => {
    const userToken = await login();
    const verifier = crypto.randomBytes(48).toString("base64url");
    const agentId = "agent-oauth-pkce";
    const consent = await api.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { agent_id: agentId, scope: ["availability.read"], code_challenge: s256Challenge(verifier), code_challenge_method: "S256" },
    });
    const code = consent.json().authorization_code as string;
    const bad = await api.inject({ method: "POST", url: "/v1/oauth/token", payload: { grant_type: "authorization_code", code, code_verifier: crypto.randomBytes(48).toString("base64url"), agent_id: agentId } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_grant");
  });

  it("consent 需登入：無 user token → 401", async () => {
    const res = await api.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      payload: { agent_id: "x", scope: ["availability.read"], code_challenge: "a".repeat(43), code_challenge_method: "S256" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("scoped token 只帶所勾 scope：僅唯讀 → delegate 落實被 insufficient_scope 擋", async () => {
    const userToken = await login();
    const verifier = crypto.randomBytes(48).toString("base64url");
    const agentId = "agent-oauth-readonly";
    const consent = await api.inject({
      method: "POST",
      url: "/v1/oauth/consent",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { agent_id: agentId, scope: ["availability.read"], code_challenge: s256Challenge(verifier), code_challenge_method: "S256" },
    });
    const code = consent.json().authorization_code as string;
    const tokenRes = await api.inject({ method: "POST", url: "/v1/oauth/token", payload: { grant_type: "authorization_code", code, code_verifier: verifier, agent_id: agentId } });
    const access_token = tokenRes.json().access_token as string;

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    });
    const client = new Client({ name: "oauth-ro", version: "0.0.0" });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: "delegate_complex_scheduling", arguments: { task_description: "x", confirm: true } });
      const r = res as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).error).toBe("insufficient_scope");
    } finally {
      await transport.close();
    }
  });
});
