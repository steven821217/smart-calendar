import type { FastifyInstance } from "fastify";
import { ConsentInput, TokenInput, WRITE_SCOPES, type AgentScopeT } from "@scal/shared";
import { verifyJwt } from "./jwt.js";
import { issueAuthorizationCode, exchangeCodeForToken, OAuthError } from "./oauth.js";
import { writeAudit } from "../audit/service.js";

/**
 * OAuth 2.1 端點（mcp.md §3）。掛在 /v1/oauth/*（於 pep 白名單，onRequest 不強制注入 auth）：
 *  - POST /v1/oauth/consent  使用者（帶 user JWT）授權某 agent 的 scope → authorization_code。
 *  - POST /v1/oauth/token    agent 用 code + PKCE verifier 換 scoped access token（公開端點）。
 * 撤銷沿用 DELETE /v1/agents/:id/authorization（agents/routes.ts，即時 Redis 黑名單）。
 */
function problem(status: number, title: string, detail?: string) {
  return { type: `https://api.example.com/errors/${title}`, title, status, detail };
}

function oauthErr(e: OAuthError) {
  // OAuth 2.1：token 端點錯誤回 400 + { error, error_description }
  const status = e.code === "server_error" ? 500 : 400;
  return { status, body: { error: e.code, error_description: e.message } };
}

export function registerOAuthRoutes(app: FastifyInstance) {
  // consent：需已登入使用者。自行驗 user JWT（此路由在 /v1/oauth 白名單內）。
  app.post("/v1/oauth/consent", async (req, reply) => {
    const auth = verifyJwt(req.headers.authorization);
    if (!auth) return reply.code(401).send(problem(401, "unauthorized", "login required to grant consent"));

    const parsed = ConsentInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send(problem(422, "validation", parsed.error.message));
    }
    const { agent_id, scope, code_challenge, code_challenge_method, ttl_seconds } = parsed.data;
    void ttl_seconds; // 目前 token 壽命由 server 設定（env）；欄位保留供未來細緻化

    // 最小授權提醒：勾了寫入類 scope 需使用者明確選取（此處已由 UI 勾選送入，僅記稽核）
    const requestedWrites = scope.filter((s) => (WRITE_SCOPES as AgentScopeT[]).includes(s));

    try {
      const { code, expires_in } = await issueAuthorizationCode({
        workspace: auth.workspace,
        user_sub: auth.sub,
        roles: auth.roles,
        agent_id,
        scope,
        code_challenge,
        code_challenge_method,
      });

      // 稽核：使用者對 agent 的授權決定（誰、授了什麼 scope）
      await writeAudit(auth.workspace, {
        actor_type: "user",
        action: "agent.consent",
        target_type: "agent",
        agent_id,
        decision: "allow",
        metadata: { by: auth.sub, scope, write_scopes: requestedWrites },
      });

      return reply.code(201).send({ authorization_code: code, expires_in });
    } catch (e) {
      if (e instanceof OAuthError) {
        const { status, body } = oauthErr(e);
        return reply.code(status).send(body);
      }
      throw e;
    }
  });

  // token：公開端點（agent 尚無 token）。code + PKCE verifier → scoped access token。
  app.post("/v1/oauth/token", async (req, reply) => {
    const parsed = TokenInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", error_description: parsed.error.message });
    }
    try {
      const tok = await exchangeCodeForToken({
        code: parsed.data.code,
        code_verifier: parsed.data.code_verifier,
        agent_id: parsed.data.agent_id,
      });
      // OAuth 2.1 token 回應建議禁快取
      reply.header("cache-control", "no-store");
      return reply.code(200).send(tok);
    } catch (e) {
      if (e instanceof OAuthError) {
        const { status, body } = oauthErr(e);
        return reply.code(status).send(body);
      }
      throw e;
    }
  });
}
