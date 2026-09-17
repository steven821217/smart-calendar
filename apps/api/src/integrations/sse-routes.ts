import type { FastifyInstance } from "fastify";
import { verifyJwt } from "../auth/jwt.js";
import { liveBus, type LiveEvent } from "./live-bus.js";

/**
 * SSE 即時推播端點（取代前端 20s 輪詢）。
 *
 * GET /v1/events/stream?access_token=<jwt>
 *
 * 為何用 query token：瀏覽器原生 `EventSource` 無法帶自訂 header（不能送
 * Authorization: Bearer），故 token 走 query。安全不變 —— 同一顆簽章 JWT，
 * 路由層自行 verifyJwt（auth hook 已放行本路徑，比照 RSVP 的路由自驗模式）；
 * 傳輸只在 loopback / gateway 內網（api 不對公網）。
 *
 * 只推「與連線者同 workspace」的事件（ISO-3：跨 workspace 事件永不外洩）。
 */
export function registerSseRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { access_token?: string } }>("/v1/events/stream", async (req, reply) => {
    const auth = verifyJwt(req.query.access_token ? `Bearer ${req.query.access_token}` : undefined);
    if (!auth) {
      return reply.code(401).send({ type: "…/unauthorized", title: "unauthorized", status: 401 });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // 告訴 nginx 不要緩衝 SSE（gateway 反代即時性）
    });
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);

    const send = (ev: LiveEvent) => {
      // ISO-3：只送同 workspace
      if (ev.workspaceId !== auth.workspace) return;
      reply.raw.write(`event: ${ev.type}\n`);
      reply.raw.write(`data: ${JSON.stringify({ type: ev.type, payload: ev.payload, at: ev.at })}\n\n`);
    };

    const unsub = liveBus.onLive(send);

    // 心跳：每 25s 送註解行，避免 proxy/瀏覽器閒置斷線。
    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping ${Date.now()}\n\n`);
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsub();
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    // 讓 Fastify 不自動結束回應（長連線由我們自己維護）
    return reply;
  });
}
