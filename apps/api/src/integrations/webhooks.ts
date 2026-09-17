import { createHmac, timingSafeEqual } from "node:crypto";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { withWorkspace } from "../db/pool.js";
import { liveBus } from "./live-bus.js";

/**
 * 事件生命週期 Webhook（REQ-N3 / 10.2）。
 * - HMAC-SHA256 簽章（per-webhook secret），簽 timestamp + body 防重放/竄改。
 * - 送出經 BullMQ 佇列：attempts + 指數退避；removeOnFail:false 保留供 DLQ。
 * - 事件驅動，不輪詢 DB（ASYNC-*）。
 */

export type WebhookEventType =
  | "event.created"
  | "event.updated"
  | "event.deleted"
  | "resource.booked"
  | "resource.booking_cancelled"
  | "scheduling.needs_decision"
  | "scheduling.rsvp_pending";

export interface WebhookJobData {
  workspaceId: string;
  webhookId: string;
  url: string;
  secret: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  deliveryId: string;
  timestamp: string; // ISO；納入簽章
}

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
});

export const webhooksQueue = new Queue<WebhookJobData>("webhooks", { connection });

/**
 * 產生簽章 header。簽 `${timestamp}.${rawBody}`（Stripe 風格），
 * 收端以同一 secret 重算比對，並檢查 timestamp 時窗防重放。
 */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/** 收端驗章（給訂閱者/測試用）：常數時間比較，避免時序側信道。 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  toleranceSec = 300,
  nowMs = Date.now(),
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k?.trim(), v?.trim()];
    }),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const asNum = Number(t);
  if (Number.isFinite(asNum)) {
    const tsMs = String(t).length <= 10 ? asNum * 1000 : asNum;
    if (Math.abs(nowMs - tsMs) > toleranceSec * 1000) return false;
  } else {
    const tsMs = new Date(t).getTime();
    if (Number.isFinite(tsMs) && Math.abs(nowMs - tsMs) > toleranceSec * 1000) return false;
  }
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(v1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** DELIVERY id：穩定去重（jobId），同一事件同一 webhook 只送一次。 */
export function webhookDeliveryId(webhookId: string, eventType: string, targetId: string): string {
  return `wh.${webhookId}.${eventType}.${targetId}`;
}

/**
 * 發布一個生命週期事件到所有訂閱該事件的 active webhook（本 workspace，RLS 兜底）。
 * 為每個 webhook 排一個 delivery job。回傳排入的 deliveryId 陣列。
 */
export async function publishEvent(
  workspaceId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown> & { id?: string },
): Promise<string[]> {
  // 即時推播：先 emit 到進程內 bus，連著的瀏覽器（SSE）立刻收到，
  // 不受 webhook 訂閱者有無影響（前端即時反映用）。
  liveBus.emitLive({ workspaceId, type: eventType, payload, at: new Date().toISOString() });

  const hooks = await withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT id, url, secret, events FROM webhooks
        WHERE active = true AND ($1 = ANY(events) OR '*' = ANY(events))`,
      [eventType],
    );
    return r.rows as Array<{ id: string; url: string; secret: string; events: string[] }>;
  });

  const timestamp = new Date().toISOString();
  const targetId = String(payload.id ?? timestamp);
  const ids: string[] = [];
  for (const h of hooks) {
    const deliveryId = webhookDeliveryId(h.id, eventType, targetId);
    await webhooksQueue.add(
      "deliver",
      {
        workspaceId,
        webhookId: h.id,
        url: h.url,
        secret: h.secret,
        eventType,
        payload,
        deliveryId,
        timestamp,
      },
      {
        jobId: deliveryId,
        attempts: 5,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false, // 失敗保留供 DLQ 檢視/重放
      },
    );
    ids.push(deliveryId);
  }
  return ids;
}
