import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt } from "../src/auth/jwt.js";
import { webhooksQueue } from "../src/integrations/webhooks.js";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS_A: string, WS_B: string, MEM_A: string, MEM_B: string;
const app = buildServer();

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS_A = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  WS_B = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-b'`)).rows[0].id;
  MEM_A = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS_A])).rows[0].id;
  MEM_B = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS_B])).rows[0].id;
  await admin.query(`DELETE FROM webhooks WHERE url LIKE 'https://example.test/%'`);
  await admin.end();
  await app.ready();
});

afterAll(async () => {
  await webhooksQueue.close();
});

const adminTokA = () => signJwt({ sub: MEM_A, workspace: WS_A, roles: ["admin"] });
const memberTokA = () => signJwt({ sub: MEM_A, workspace: WS_A, roles: ["member"] });
const adminTokB = () => signJwt({ sub: MEM_B, workspace: WS_B, roles: ["admin"] });

describe("POST /v1/events/parse (api.md 19, 5.4)", () => {
  it("member 可解析 NL → 草稿", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/events/parse",
      headers: { authorization: `Bearer ${memberTokA()}` },
      payload: { text: "Sync tomorrow 10am", reference_now_utc: "2026-01-05T00:00:00Z", default_timezone: "UTC" },
    });
    expect(res.statusCode).toBe(200);
    const { draft } = res.json();
    expect(draft.start_utc).toBe("2026-01-06T10:00:00.000Z");
    expect(draft.title.toLowerCase()).toContain("sync");
  });

  it("缺欄位 → 422", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/events/parse",
      headers: { authorization: `Bearer ${memberTokA()}` },
      payload: { text: "hello" }, // 缺 default_timezone
    });
    expect(res.statusCode).toBe(422);
  });

  it("無 token → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/events/parse", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("Webhook 管理端點 (api.md 29, REQ-N3)", () => {
  let created: string;

  it("非 admin → 403（同 workspace 越權）", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks",
      headers: { authorization: `Bearer ${memberTokA()}` },
      payload: { url: "https://example.test/hook", events: ["event.created"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin 建立 → 201，回傳 secret 一次", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks",
      headers: { authorization: `Bearer ${adminTokA()}` },
      payload: { url: "https://example.test/hook", events: ["event.created", "event.deleted"] },
    });
    expect(res.statusCode).toBe(201);
    const wh = res.json();
    expect(wh.id).toBeTruthy();
    expect(wh.secret).toBeTruthy();
    created = wh.id;
  });

  it("列出可見自建 webhook（不回 secret）", async () => {
    const res = await app.inject({
      method: "GET", url: "/v1/webhooks",
      headers: { authorization: `Bearer ${adminTokA()}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().webhooks;
    const mine = rows.find((w: { id: string }) => w.id === created);
    expect(mine).toBeTruthy();
    expect(mine.secret).toBeUndefined();
  });

  it("ISO：ws-b admin 看不到 ws-a 的 webhook", async () => {
    const res = await app.inject({
      method: "GET", url: "/v1/webhooks",
      headers: { authorization: `Bearer ${adminTokB()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhooks.some((w: { id: string }) => w.id === created)).toBe(false);
  });

  it("ISO：ws-b admin 刪 ws-a 的 webhook → 404（跨 ws 不洩漏）", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/webhooks/${created}`,
      headers: { authorization: `Bearer ${adminTokB()}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("admin 刪自家 webhook → 204", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/v1/webhooks/${created}`,
      headers: { authorization: `Bearer ${adminTokA()}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
