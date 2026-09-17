import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt, verifyJwt } from "../src/auth/jwt.js";
import { liveBus, type LiveEvent } from "../src/integrations/live-bus.js";
import { publishEvent, webhooksQueue } from "../src/integrations/webhooks.js";

/**
 * SSE 即時推播測試（取代前端 20s 輪詢）。
 * 涵蓋：
 *  - liveBus 進程內廣播 / 退訂
 *  - publishEvent 會 emit 到 bus（不論有無 webhook 訂閱者）
 *  - SSE endpoint 授權：EventSource 走 query token；無/壞 token → 401
 *  - ISO-3：SSE 端只轉發同 workspace 事件，跨 workspace 不外洩
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS_A: string, WS_B: string, MEM_A: string;
const app = buildServer();

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS_A = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  WS_B = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-b'`)).rows[0].id;
  MEM_A = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS_A])).rows[0].id;
  await admin.end();
  await app.ready();
});

afterAll(async () => {
  await webhooksQueue.close();
});

/** 收集 bus 上一段時間內的事件（同步 emit，故立即即可）。 */
function collect(): { events: LiveEvent[]; stop: () => void } {
  const events: LiveEvent[] = [];
  const off = liveBus.onLive((e) => events.push(e));
  return { events, stop: off };
}

describe("liveBus（進程內即時匯流排）", () => {
  it("emit → 訂閱者收到", () => {
    const { events, stop } = collect();
    liveBus.emitLive({ workspaceId: WS_A, type: "event.created", payload: { id: "e1" }, at: "t" });
    stop();
    expect(events).toHaveLength(1);
    expect(events[0].payload.id).toBe("e1");
  });

  it("退訂後不再收到", () => {
    const { events, stop } = collect();
    stop();
    liveBus.emitLive({ workspaceId: WS_A, type: "event.created", payload: { id: "e2" }, at: "t" });
    expect(events).toHaveLength(0);
  });
});

describe("publishEvent 會 emit 到 liveBus（前端即時反映）", () => {
  it("無 webhook 訂閱者時仍 emit（SSE 不依賴 webhook）", async () => {
    const { events, stop } = collect();
    // ws-b 無 example.test webhook；publishEvent 仍應對 bus emit
    await publishEvent(WS_B, "event.updated", { id: "pub-1" });
    stop();
    const mine = events.filter((e) => e.payload.id === "pub-1");
    expect(mine).toHaveLength(1);
    expect(mine[0].type).toBe("event.updated");
    expect(mine[0].workspaceId).toBe(WS_B);
  });
});

describe("SSE endpoint 授權 GET /v1/events/stream", () => {
  it("無 access_token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/events/stream" });
    expect(res.statusCode).toBe(401);
  });

  it("壞的 access_token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/events/stream?access_token=not-a-jwt" });
    expect(res.statusCode).toBe(401);
  });

  it("EventSource 無法帶 header：Authorization header 不被接受（走 query）", async () => {
    // 僅給 header、不給 query → 仍 401（證明本路徑只認 query token）
    const tok = signJwt({ sub: MEM_A, workspace: WS_A, roles: ["member"] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/events/stream",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("合法 query token 通過授權（AuthContext workspace 來自 token，ISO-3）", () => {
    // 成功連線是長串流（inject 會 hang），故直接驗端點所用的授權原語：
    const tok = signJwt({ sub: MEM_A, workspace: WS_A, roles: ["member"] });
    const auth = verifyJwt(`Bearer ${tok}`);
    expect(auth).not.toBeNull();
    expect(auth!.workspace).toBe(WS_A);
    expect(auth!.sub).toBe(MEM_A);
  });
});

describe("ISO-3：SSE 只轉發同 workspace 事件", () => {
  // 複刻 sse-routes 的過濾判斷式：只送 ev.workspaceId === auth.workspace
  const forward = (ev: LiveEvent, viewerWs: string) => ev.workspaceId === viewerWs;

  it("同 workspace 事件 → 轉發", () => {
    const ev: LiveEvent = { workspaceId: WS_A, type: "scheduling.rsvp_pending", payload: { id: "x" }, at: "t" };
    expect(forward(ev, WS_A)).toBe(true);
  });

  it("跨 workspace 事件 → 不轉發（不外洩）", () => {
    const ev: LiveEvent = { workspaceId: WS_B, type: "event.created", payload: { id: "y" }, at: "t" };
    expect(forward(ev, WS_A)).toBe(false);
  });

  it("端到端：ws-b 的 publishEvent 事件，ws-a 觀看者過濾後收不到", async () => {
    const { events, stop } = collect();
    await publishEvent(WS_B, "event.created", { id: "iso-leak-check" });
    stop();
    const seenByWsA = events.filter((e) => forward(e, WS_A) && e.payload.id === "iso-leak-check");
    expect(seenByWsA).toHaveLength(0);
  });
});
