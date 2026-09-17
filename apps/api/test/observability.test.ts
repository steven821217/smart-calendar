import { describe, it, expect, beforeAll } from "vitest";
import { buildServer } from "../src/server.js";
import { signJwt } from "../src/auth/jwt.js";

/**
 * 可觀測性測試（task 10.4）：
 * - GET /metrics → 200 且含預期 metric 名稱（純文字 Prometheus 格式）。
 * - 帶 JWT 的請求被計數，且 workspace label 出現（每-workspace 維度）。
 *
 * 設計：不依賴 DB。帶 JWT 打受保護路由時，onRequest 的 auth hook 會先設好
 * req.auth.workspace；即使該路由 handler 之後因無 DB 而回錯，onResponse 的
 * 指標 hook 仍會以 req.auth 的 workspace 記數。故本測試只斷言「計數 + label」，
 * 不斷言業務結果。與 reminders-api.test.ts 對齊：buildServer() + signJwt() + inject。
 */

const WS = "11111111-1111-1111-1111-111111111111";
const MEM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const memberTok = () => signJwt({ sub: MEM, workspace: WS, roles: ["member"] });

const app = buildServer();
beforeAll(async () => {
  await app.ready();
});

describe("Observability /metrics（task 10.4）", () => {
  it("GET /metrics → 200，含預期 metric 名稱且為 Prometheus 純文字", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const body = res.payload;
    // 自訂 http 指標
    expect(body).toContain("scal_http_requests_total");
    expect(body).toContain("scal_http_request_duration_seconds");
    // reminders 發送計數
    expect(body).toContain("scal_reminders_sent_total");
    // Node 預設指標（前綴 scal_）
    expect(body).toContain("scal_process_cpu_user_seconds_total");
  });

  it("/metrics 無需 JWT（比照 /health 放行）", async () => {
    // 未帶 Authorization 仍應 200，而非 401。
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });

  it("帶 JWT 的請求被計數，且 workspace label = workspace_id 出現", async () => {
    // 打一個受保護路由（auth hook 會設 req.auth.workspace）。
    // 即使 handler 因無 DB 回 5xx，onResponse 指標 hook 仍以該 workspace 記數。
    await app.inject({
      method: "GET",
      url: "/v1/me/pending-rsvps",
      headers: { authorization: `Bearer ${memberTok()}` },
    });

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    const body = metrics.payload;

    // workspace_id 應作為 label 出現在 http 請求計數上（每-workspace 維度）。
    expect(body).toContain(`workspace="${WS}"`);
    // 該筆計數對應的 route 應為路由樣板而非含 id 的實際 URL（基數控制）。
    const line = body
      .split("\n")
      .find(
        (l) =>
          l.startsWith("scal_http_requests_total{") &&
          l.includes(`workspace="${WS}"`) &&
          l.includes(`route="/v1/me/pending-rsvps"`),
      );
    expect(line, "應有帶 workspace label 的 http_requests_total 樣本").toBeTruthy();
  });

  it("未認證請求以 anonymous 記數（不外洩身份）", async () => {
    // /health 被 auth hook 放行 → 無 req.auth → workspace=anonymous。
    await app.inject({ method: "GET", url: "/health" });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.payload).toContain(`workspace="anonymous"`);
  });
});
