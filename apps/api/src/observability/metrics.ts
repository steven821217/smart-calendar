import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import client from "prom-client";

/**
 * 每-workspace 維度的可觀測性（task 10.4）：
 * - Prometheus 指標（prom-client）：http 請求計數 + 延遲 histogram，label 含 workspace_id。
 * - 每請求結構化日誌帶 workspace_id（未認證標 anonymous）與 request id（Fastify reqId）。
 * - request id 貫穿日誌並作為 histogram exemplar（trace_id），關聯指標與 log。
 *
 * 隱私（不得記錄私密內容）：
 * - 僅記錄 method / route(pattern) / status_code / workspace_id / reqId，
 *   絕不記錄 request body、事件標題、email 等內容。
 * - workspace label 基數控制：只用 workspace_id（租戶數量有限），
 *   route 用 Fastify 的「路由樣板」（如 /v1/events/:id）而非實際 URL，
 *   避免把 event_id 之類高基數值寫進 label。
 */

// 專屬 registry：避免與其他測試/程序的預設 registry 互相污染，
// 同時便於在測試中重建 server 時清空狀態。
export const registry = new client.Registry();

// Node.js 執行期預設指標（GC、eventloop、heap 等），加上共用前綴。
client.collectDefaultMetrics({ register: registry, prefix: "scal_" });

/** http 請求總數（labels 皆為有限基數）。 */
export const httpRequestsTotal = new client.Counter({
  name: "scal_http_requests_total",
  help: "HTTP 請求總數（依 method/route/status/workspace）",
  labelNames: ["method", "route", "status_code", "workspace"] as const,
  registers: [registry],
});

/** http 請求延遲（秒）histogram，支援 exemplar（trace_id = reqId）。 */
export const httpRequestDuration = new client.Histogram({
  name: "scal_http_request_duration_seconds",
  help: "HTTP 請求延遲（秒），依 method/route/status/workspace",
  labelNames: ["method", "route", "status_code", "workspace"] as const,
  // Web API 常見延遲分桶（毫秒級到秒級）。
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/**
 * reminders 發送計數（10.4-2）：先接既有 worker 結果。
 * 取捨：worker 是獨立 process（bullmq），與 API 不同記憶體空間，
 * 其指標無法直接進 API 的 registry。完整方案需 worker 自曝 /metrics 或
 * 推送 pushgateway，成本較高；此處先在 API 內定義計數器並提供
 * recordReminderSent() 供「同 process」的呼叫點累加（例如 API 直接觸發時），
 * worker 端串接留待後續（見回報「取捨」）。
 */
export const remindersSentTotal = new client.Counter({
  name: "scal_reminders_sent_total",
  help: "已發送提醒數（依 workspace/result）",
  labelNames: ["workspace", "result"] as const,
  registers: [registry],
});

/** 供 reminders 發送點累加（同 process）。result：sent / skipped / failed。 */
export function recordReminderSent(workspace: string, result: "sent" | "skipped" | "failed") {
  remindersSentTotal.inc({ workspace: workspace || "anonymous", result });
}

/** 由 req.auth 取 workspace_id；未認證請求標 anonymous。 */
function workspaceOf(req: FastifyRequest): string {
  return req.auth?.workspace ?? "anonymous";
}

/**
 * route label：優先用 Fastify 路由樣板（routeOptions.url，如 /v1/events/:id），
 * 找不到（如 404 未匹配路由）則歸為 __unknown__，
 * 絕不使用 req.url（含實際 id）以免 label 基數爆炸。
 */
function routeOf(req: FastifyRequest): string {
  // Fastify 4：req.routeOptions?.url；退回舊欄位 req.routerPath。
  const anyReq = req as unknown as {
    routeOptions?: { url?: string };
    routerPath?: string;
  };
  return anyReq.routeOptions?.url ?? anyReq.routerPath ?? "__unknown__";
}

/**
 * 註冊可觀測性：指標收集 hook、/metrics 端點、每請求 workspace 日誌。
 * 需在 registerAuth() 之後註冊，才能在 onResponse 讀到 req.auth。
 */
export function registerObservability(app: FastifyInstance) {
  const enabled = (process.env.METRICS_ENABLED ?? "true") !== "false";

  // 每請求起始時間，供延遲計算（用 hrtime 避免時鐘跳動影響）。
  app.addHook("onRequest", async (req: FastifyRequest) => {
    (req as unknown as { _startNs?: bigint })._startNs = process.hrtime.bigint();
  });

  // 回應完成時：記指標 + 帶 workspace_id/reqId 的結構化日誌。
  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const workspace = workspaceOf(req);
    const route = routeOf(req);
    const method = req.method;
    const statusCode = String(reply.statusCode);

    if (enabled) {
      const startNs = (req as unknown as { _startNs?: bigint })._startNs;
      const seconds = startNs ? Number(process.hrtime.bigint() - startNs) / 1e9 : 0;
      const labels = { method, route, status_code: statusCode, workspace };
      httpRequestsTotal.inc(labels);
      // 延遲樣本。request-id 關聯：prom-client 的 exemplarLabels 型別受限於本 metric
      // 已宣告的 label 名（不含 trace_id），且 exemplar 僅在 OpenMetrics 抓取格式下輸出；
      // 為避免把 trace_id 宣告成 label（會炸基數），改由「結構化日誌」帶 req_id 做關聯
      // （見下方 req.log.info）。完整 exemplar 需搭配 OTel/OpenMetrics exporter，列為延伸。
      httpRequestDuration.observe(labels, seconds);
    }

    // 結構化日誌：僅維度欄位，無 body / 無私密內容。
    req.log.info(
      { workspace_id: workspace, route, method, status_code: reply.statusCode, req_id: req.id },
      "request completed",
    );
  });

  // GET /metrics：純文字 Prometheus 格式。
  // 在 auth hook 已放行（見 pep.ts 白名單），抓取端無需 JWT。
  // 安全預設：server.ts 綁 loopback；容器化時只經 gateway 內網，不對外 publish。
  app.get("/metrics", async (_req, reply) => {
    if (!enabled) {
      // METRICS_ENABLED=false → 明確關閉，回 404（等同未提供此端點）。
      return reply.code(404).send({ type: "…/not-found", title: "metrics disabled", status: 404 });
    }
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
