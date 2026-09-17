import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerAuth } from "./auth/pep.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerOAuthRoutes } from "./auth/oauth-routes.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerCalendarRoutes } from "./calendars/routes.js";
import { registerSchedulingRoutes } from "./scheduling/routes.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { registerResourceRoutes } from "./resources/routes.js";
import { registerReminderRoutes } from "./reminders/routes.js";
import { registerWebhookRoutes } from "./integrations/routes.js";
import { registerSseRoutes } from "./integrations/sse-routes.js";
import { registerInAppAgentRoutes } from "./agents/inapp/routes.js";
import { registerGroupRoutes } from "./groups/routes.js";
import { registerObservability } from "./observability/metrics.js";

export function buildServer() {
  const app = Fastify({ logger: true });

  // CORS：dev 允許 Vite（5173）本機來源；正式改為明確 allow-list。
  // 憑證用 Authorization header（Bearer），非 cookie，故不需 credentials。
  app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((s) => s.trim()),
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key"],
  });

  app.get("/health", async () => ({ status: "ok" }));
  registerAuth(app); // onRequest JWT hook（放行 /health、/metrics、/v1/auth/*）
  registerObservability(app); // 指標 + /metrics + 每請求 workspace 日誌（需在 auth 後，onResponse 才讀得到 req.auth）
  registerAuthRoutes(app); // login / me
  registerOAuthRoutes(app); // OAuth 2.1 consent / token（mcp.md §3）
  registerEventRoutes(app);
  registerCalendarRoutes(app);
  registerSchedulingRoutes(app);
  registerAgentRoutes(app);
  registerResourceRoutes(app);
  registerReminderRoutes(app);
  registerWebhookRoutes(app);
  registerSseRoutes(app); // SSE 即時推播 /v1/events/stream
  registerInAppAgentRoutes(app); // 站內對話 agent /v1/agent/chat
  registerGroupRoutes(app);
  return app;
}

// 直接執行時啟動
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  // 預設綁 loopback（本機安全預設）；容器化在 gateway 後時以 HOST=0.0.0.0 覆寫，
  // 對外安全由「不 publish host 埠 + 只經 gateway」保證。
  const host = process.env.HOST ?? "127.0.0.1";
  app
    .listen({ port, host })
    .then(() => app.log.info(`api on ${host}:${port}`))
    .catch((e) => {
      app.log.error(e);
      process.exit(1);
    });
}
