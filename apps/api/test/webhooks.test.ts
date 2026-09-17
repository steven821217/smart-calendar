import { describe, it, expect } from "vitest";
import { signWebhook, verifyWebhookSignature, webhookDeliveryId } from "../src/integrations/webhooks.js";

describe("Webhook HMAC signing (10.2 / REQ-N3)", () => {
  const secret = "test-secret-at-least-16-chars-long";
  const ts = "1767225600"; // 2026-01-01T00:00:00Z（秒）
  const body = JSON.stringify({ type: "event.created", data: { id: "abc" } });

  it("簽章可被同 secret 驗回（時窗內）", () => {
    const header = signWebhook(secret, ts, body);
    expect(header).toMatch(/^t=.*,v1=[0-9a-f]{64}$/);
    const ok = verifyWebhookSignature(secret, header, body, 300, Number(ts) * 1000 + 1000);
    expect(ok).toBe(true);
  });

  it("竄改 body → 驗章失敗", () => {
    const header = signWebhook(secret, ts, body);
    const ok = verifyWebhookSignature(secret, header, body + "x", 300, Number(ts) * 1000);
    expect(ok).toBe(false);
  });

  it("錯誤 secret → 驗章失敗", () => {
    const header = signWebhook(secret, ts, body);
    const ok = verifyWebhookSignature("wrong-secret-wrong-secret", header, body, 300, Number(ts) * 1000);
    expect(ok).toBe(false);
  });

  it("超出時窗（防重放）→ 驗章失敗", () => {
    const header = signWebhook(secret, ts, body);
    const wayLater = Number(ts) * 1000 + 10 * 60 * 1000; // +10 分，超過 300s
    expect(verifyWebhookSignature(secret, header, body, 300, wayLater)).toBe(false);
  });

  it("deliveryId 穩定去重：同 (webhook,event,target) 相同", () => {
    const a = webhookDeliveryId("wh1", "event.created", "ev1");
    const b = webhookDeliveryId("wh1", "event.created", "ev1");
    expect(a).toBe(b);
    expect(a).not.toContain(":"); // BullMQ jobId 不含冒號
  });
});
