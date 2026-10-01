import type { FastifyInstance, FastifyRequest } from "fastify";
import { AgentScope } from "@scal/shared";
import { tokenLifetimeDays } from "./oauth.js";

/**
 * OAuth 2.1 自動發現 metadata（MCP 授權規範）。
 *
 * 為什麼需要它：支援自動授權的 MCP client（Claude.ai web / ChatGPT / Cursor HTTP…）
 * 的流程是——先無 token 打 /mcp → 收到 401 + `WWW-Authenticate: Bearer
 * resource_metadata="…"` → 抓 protected resource metadata（RFC 9728）→ 得知授權
 * 伺服器 → 抓 authorization server metadata（RFC 8414）→ 走 PKCE 導向流程拿 token。
 * 少了這兩份文件，client 無從得知要去哪裡授權，只能請使用者手動貼 token。
 *
 * 兩個端點都必須**免驗證**且與 MCP 端點同源（見 gateway 的 /.well-known 路由）。
 */

/** 對外基底 URL：優先用 PUBLIC_BASE_URL，否則由反代標頭推導（gateway 會帶）。 */
export function publicBaseUrl(req: FastifyRequest): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "127.0.0.1";
  return `${proto}://${host}`;
}

/** MCP 資源識別（RFC 8707 的 resource 值）＝ MCP 端點本身。 */
export function mcpResourceUrl(req: FastifyRequest): string {
  return `${publicBaseUrl(req)}/mcp`;
}

export function registerOAuthMetadataRoutes(app: FastifyInstance) {
  // RFC 9728：受保護資源 metadata。宣告「我是誰、該找哪個授權伺服器、支援哪些 scope」。
  app.get("/.well-known/oauth-protected-resource", async (req, reply) => {
    const base = publicBaseUrl(req);
    reply.header("cache-control", "public, max-age=3600");
    return {
      resource: mcpResourceUrl(req),
      authorization_servers: [base],
      scopes_supported: AgentScope.options,
      bearer_methods_supported: ["header"],
      resource_documentation: `${base}/`,
    };
  });

  // 同一份文件掛在 /mcp 之下：部分 client 會依 RFC 9728 的路徑組合規則去抓
  //（/.well-known/oauth-protected-resource/<resource path>）。
  app.get("/.well-known/oauth-protected-resource/mcp", async (req, reply) => {
    const base = publicBaseUrl(req);
    reply.header("cache-control", "public, max-age=3600");
    return {
      resource: mcpResourceUrl(req),
      authorization_servers: [base],
      scopes_supported: AgentScope.options,
      bearer_methods_supported: ["header"],
    };
  });

  // RFC 8414：授權伺服器 metadata。
  const asMetadata = (req: FastifyRequest) => {
    const base = publicBaseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/v1/oauth/authorize`,
      token_endpoint: `${base}/v1/oauth/token`,
      scopes_supported: AgentScope.options,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      // OAuth 2.1：公開 client + PKCE S256（不支援 plain）
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      // RFC 8707：本伺服器認得 resource 參數（會寫進 token 的 aud）
      authorization_response_iss_parameter_supported: false,
      service_documentation: `${base}/`,
      // 非標準欄位（RFC 8414 允許擴充）：讓同意頁能誠實顯示「這次授權維持多久」。
      // PoC 不做 refresh token，改用長效 token + 即時撤銷，故此值會是數十天。
      scal_access_token_lifetime_days: tokenLifetimeDays(),
    };
  };
  app.get("/.well-known/oauth-authorization-server", async (req, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return asMetadata(req);
  });
  // OpenID 風格的別名，部分 client 只找這個路徑
  app.get("/.well-known/openid-configuration", async (req, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return asMetadata(req);
  });
}
