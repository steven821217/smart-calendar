import { Worker } from "bullmq";
import IORedis from "ioredis";
import { signWebhook, type WebhookJobData } from "./webhooks.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
});

/**
 * webhooks worker：對訂閱者 URL 做 HTTP POST，帶 HMAC 簽章 header。
 * 非 2xx → throw → BullMQ 依 attempts/backoff 重試；耗盡後留在 failed set（DLQ）。
 * 事件驅動，不輪詢 DB。
 */
export function startWebhooksWorker() {
  return new Worker<WebhookJobData>(
    "webhooks",
    async (job) => {
      const { url, secret, eventType, payload, deliveryId, timestamp } = job.data;
      const rawBody = JSON.stringify({ type: eventType, delivery_id: deliveryId, data: payload });
      const signature = signWebhook(secret, timestamp, rawBody);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scal-event": eventType,
          "x-scal-delivery": deliveryId,
          "x-scal-signature": signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // 非 2xx → 失敗，交給 BullMQ 重試/DLQ
        throw new Error(`webhook ${url} responded ${res.status}`);
      }
      return { status: res.status };
    },
    { connection, concurrency: 5 },
  );
}

if (process.argv[1] && process.argv[1].endsWith("webhook-worker.ts")) {
  const w = startWebhooksWorker();
  process.on("SIGTERM", async () => {
    await w.close();
    process.exit(0);
  });
  console.log("webhooks worker started");
}
