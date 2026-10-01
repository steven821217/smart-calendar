import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyJwt, type AuthContext } from "./jwt.js";
import { authorize, type AuthzResource } from "./pdp.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

function problem(status: number, title: string, detail?: string) {
  return { type: `https://api.example.com/errors/${title}`, title, status, detail };
}

/** AuthN：每個請求驗 JWT → 建 AuthContext（ISO-3：脈絡僅來自 token）。 */
export function registerAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // /metrics：抓取端無 JWT，比照 /health 放行（安全靠 loopback/gateway 內網，見 observability/metrics.ts）。
    // /.well-known/*：OAuth 自動發現 metadata 必須可匿名讀取（RFC 9728 / RFC 8414）。
    if (
      req.url === "/health" ||
      req.url === "/metrics" ||
      req.url.startsWith("/.well-known/") ||
      req.url.startsWith("/v1/auth/") ||
      req.url.startsWith("/v1/oauth/")
    )
      return;
    // RSVP：以 rsvp_token 自證身份（Member 免登入回覆），路由層自行驗章。
    if (req.method === "POST" && /^\/v1\/events\/[^/]+\/rsvp(\?.*)?$/.test(req.url)) return;
    // SSE 即時推播：EventSource 無法帶 Authorization header，token 走 query，路由層自驗（見 sse-routes.ts）。
    if (req.method === "GET" && req.url.startsWith("/v1/events/stream")) return;
    const auth = verifyJwt(req.headers.authorization);
    if (!auth) return reply.code(401).send(problem(401, "unauthorized"));
    req.auth = auth;
  });
}

/**
 * PEP：在 SQL 之前對 PDP 重新求值（PEP-1/3）。
 * 跨 workspace → 404（不洩漏存在性）；同 workspace 越權 → 403。
 */
export async function enforce(
  req: FastifyRequest,
  reply: FastifyReply,
  action: string,
  resource: AuthzResource,
): Promise<boolean> {
  const auth = req.auth;
  if (!auth) {
    reply.code(401).send(problem(401, "unauthorized"));
    return false;
  }
  const decision = await authorize({ subject: auth, action, resource });
  if (!decision.allow) {
    const crossWs = resource.workspace !== auth.workspace;
    reply
      .code(crossWs ? 404 : 403)
      .send(problem(crossWs ? 404 : 403, crossWs ? "not-found" : "forbidden", decision.reason));
    return false;
  }
  return true;
}
