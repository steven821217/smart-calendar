import type { FastifyInstance } from "fastify";
import { ConsentInput, TokenInput, WRITE_SCOPES, AgentScope, type AgentScopeT } from "@scal/shared";
import { verifyJwt } from "./jwt.js";
import { issueAuthorizationCode, exchangeCodeForToken, OAuthError, isAllowedRedirectUri } from "./oauth.js";
import { publicBaseUrl } from "./oauth-metadata.js";
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
  /**
   * GET /v1/oauth/authorize — OAuth 2.1 導向端點（供自動發現的 MCP client 使用）。
   *
   * 這支不自己做認證，只負責「驗參數 → 轉去站內同意頁」。使用者在同意頁若未登入會
   * 先登入（前端處理），核准後由前端呼叫 POST /v1/oauth/consent 取得授權碼，再由
   * 瀏覽器帶 code+state 導回 client 的 redirect_uri。
   *
   * 安全要點：
   *  - redirect_uri 必須先過白名單；**不合法時絕不導回**（否則就是 open redirect），
   *    改回 400 讓使用者看到錯誤。
   *  - 強制 PKCE S256（OAuth 2.1 對公開 client 的要求）。
   *  - state 原樣帶回（CSRF）。
   */
  app.get<{
    Querystring: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      resource?: string;
    };
  }>("/v1/oauth/authorize", async (req, reply) => {
    const q = req.query;
    // redirect_uri 先驗：後續任何錯誤才可考慮以導向回報
    if (!q.redirect_uri || !isAllowedRedirectUri(q.redirect_uri)) {
      return reply
        .code(400)
        .type("text/plain; charset=utf-8")
        .send(
          "redirect_uri 不被允許。僅接受本機 loopback（http://127.0.0.1:<port>/…）" +
            "或站台白名單內的 https 位址（OAUTH_REDIRECT_ALLOWLIST）。",
        );
    }
    const redirectWithError = (error: string, description: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      return reply.redirect(302, u.toString());
    };
    if (q.response_type !== "code") {
      return redirectWithError("unsupported_response_type", "only response_type=code is supported");
    }
    if (!q.client_id) return redirectWithError("invalid_request", "client_id required");
    if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256") {
      return redirectWithError("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    // scope：空白分隔；未帶則預設唯讀（最小授權）
    const requested = (q.scope ?? "").split(/[\s+]+/).filter(Boolean);
    const allowed = AgentScope.options as readonly string[];
    const bad = requested.filter((s) => !allowed.includes(s));
    if (bad.length) return redirectWithError("invalid_scope", `unknown scope: ${bad.join(",")}`);

    // 轉去站內同意頁（hash route；前端負責登入與勾選確認）
    const params = new URLSearchParams({
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      ...(q.state ? { state: q.state } : {}),
      ...(requested.length ? { scope: requested.join(" ") } : {}),
      ...(q.resource ? { resource: q.resource } : {}),
    });
    return reply.redirect(302, `${publicBaseUrl(req)}/#/oauth/consent?${params.toString()}`);
  });

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
    // 導向流程（/v1/oauth/authorize → 同意頁）會一併帶這些，授權碼需綁定它們
    const { redirect_uri, client_id, resource } = parsed.data;
    if (redirect_uri && !isAllowedRedirectUri(redirect_uri)) {
      return reply.code(400).send(problem(400, "invalid_request", "redirect_uri not allowed"));
    }

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
        redirect_uri,
        client_id,
        resource,
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
        redirect_uri: parsed.data.redirect_uri,
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
