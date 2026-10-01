import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt, verifyJwt } from "../src/auth/jwt.js";
import { revokeAgent, unrevokeAgent } from "../src/agents/service.js";

/**
 * 綁定 token（POST /v1/agents/tokens）——使用者把外部 agent 綁到自己帳號的路徑。
 *
 * 安全邊界（本測試鎖住的性質）：
 *  - token 以呼叫者為 on-behalf-of（user_sub），sub=agent_id，roles 沿用呼叫者 → 不可提權。
 *  - scope 只能是使用者勾選的集合；非法 scope / 空 scope / 超長 TTL → 422。
 *  - agent token 不得再簽發 token（防鏈式擴權與無限續命）。
 *  - 已被撤銷的 agent 名稱不得靜默復活（409），需 admin 解除撤銷（POST .../authorization）。
 *  - 未登入 → 401。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;
let WS: string;
let MEM: string;

beforeAll(async () => {
  const c = adminClient();
  await c.connect();
  WS = (await c.query(`SELECT id FROM workspaces WHERE slug='ws-a' LIMIT 1`)).rows[0].id;
  MEM = (await c.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  await c.end();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const userToken = (roles: string[] = ["admin"]) => signJwt({ sub: MEM, workspace: WS, roles });
const issue = (body: unknown, token = userToken()) =>
  app.inject({ method: "POST", url: "/v1/agents/tokens", headers: { authorization: `Bearer ${token}` }, payload: body });

describe("POST /v1/agents/tokens：綁定外部 agent 到自己的帳號", () => {
  it("回可用的 scoped token：sub=agent_id、user_sub=簽發者、roles 沿用（不提權）", async () => {
    const res = await issue({ agent_id: "bind-test-a", scope: ["availability.read"], ttl_days: 7 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agent_id).toBe("bind-test-a");
    expect(body.on_behalf_of).toBe(MEM);
    expect(body.expires_in).toBe(7 * 86400);
    // token 內容即 MCP 用的 M2M claims
    const claims = verifyJwt(`Bearer ${body.access_token}`);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("bind-test-a");
    expect(claims!.user_sub).toBe(MEM);
    expect(claims!.workspace).toBe(WS);
    expect(claims!.scope).toEqual(["availability.read"]);
    expect(claims!.roles).toEqual(["admin"]);
  });

  it("member 簽發 → token 只有 member role（能力上限＝本人）", async () => {
    const res = await issue(
      { agent_id: "bind-test-member", scope: ["availability.read"] },
      userToken(["member"]),
    );
    expect(res.statusCode).toBe(201);
    const claims = verifyJwt(`Bearer ${res.json().access_token}`);
    expect(claims!.roles).toEqual(["member"]);
  });

  it("token 不得被快取（cache-control: no-store）", async () => {
    const res = await issue({ agent_id: "bind-test-cache", scope: ["availability.read"] });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("未登入 → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents/tokens",
      payload: { agent_id: "x", scope: ["availability.read"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("agent token 不得再簽發 token → 403", async () => {
    const agentJwt = signJwt({
      sub: "bind-test-chain",
      workspace: WS,
      roles: ["admin"],
      scope: ["availability.read"],
      user_sub: MEM,
    });
    const res = await issue({ agent_id: "escalated", scope: ["event.write"] }, agentJwt);
    expect(res.statusCode).toBe(403);
  });

  it("非法 / 空 scope 與超長 TTL → 422", async () => {
    expect((await issue({ agent_id: "x", scope: ["god.mode"] })).statusCode).toBe(422);
    expect((await issue({ agent_id: "x", scope: [] })).statusCode).toBe(422);
    expect((await issue({ agent_id: "x", scope: ["availability.read"], ttl_days: 3650 })).statusCode).toBe(422);
  });

  it("已撤銷的 agent 名稱 → 409（不得靜默復活），admin 解除撤銷後可再發", async () => {
    const agentId = "bind-test-revoked";
    await revokeAgent(WS, agentId);
    try {
      const blocked = await issue({ agent_id: agentId, scope: ["availability.read"] });
      expect(blocked.statusCode).toBe(409);

      // admin 解除撤銷
      const un = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/authorization`,
        headers: { authorization: `Bearer ${userToken()}` },
      });
      expect(un.statusCode).toBe(204);

      const ok = await issue({ agent_id: agentId, scope: ["availability.read"] });
      expect(ok.statusCode).toBe(201);
    } finally {
      await unrevokeAgent(WS, agentId);
    }
  });

  it("解除撤銷需 agent.manage（member → 403）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents/bind-test-a/authorization",
      headers: { authorization: `Bearer ${userToken(["member"])}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
