import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt } from "../src/auth/jwt.js";
import { createEvent } from "../src/events/service.js";
import { writeAudit } from "../src/audit/service.js";
import { revokeAgent } from "../src/agents/service.js";

async function ids() {
  const admin = new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  await admin.connect();
  const ws = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  const cal = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 LIMIT 1`, [ws])).rows[0].id;
  const mem = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [ws])).rows[0].id;
  await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND title='AvailBusy'`, [ws]);
  await admin.end();
  return { ws, cal, mem };
}

let WS: string, CAL: string, MEM: string;
const app = buildServer();
const AGENT_ID = "agent-alpha-test";

beforeAll(async () => {
  const c = await ids();
  WS = c.ws; CAL = c.cal; MEM = c.mem;
  await app.ready();
  // 建一筆已知忙碌事件，供 availability 計算
  await createEvent(WS, {
    calendar_id: CAL, title: "AvailBusy",
    start_utc: "2027-05-03T02:00:00Z", end_utc: "2027-05-03T03:00:00Z",
    timezone: "UTC", created_by: MEM,
  });
  // 種一筆 agent 稽核，讓 /v1/agents 能列到
  await writeAudit(WS, {
    actor_type: "agent", agent_id: AGENT_ID, on_behalf_of: MEM,
    action: "event.create", target_type: "event", decision: "allow",
    metadata: { tool: "create_smart_event", scope: ["event.write"] },
  });
});

function adminToken() {
  return signJwt({ sub: MEM, workspace: WS, roles: ["admin"] });
}
function memberToken() {
  return signJwt({ sub: MEM, workspace: WS, roles: ["member"] });
}

describe("GET /v1/availability (5.2, REQ-S1)", () => {
  it("回避開忙碌時段的候選 slots", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/availability?from=2027-05-03T00:00:00Z&to=2027-05-03T08:00:00Z&duration_minutes=30",
      headers: { authorization: `Bearer ${memberToken()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);
    // 沒有任何候選與 02:00-03:00 忙碌重疊
    const busyS = Date.parse("2027-05-03T02:00:00Z");
    const busyE = Date.parse("2027-05-03T03:00:00Z");
    for (const s of body.slots) {
      const ss = Date.parse(s.start_utc), se = Date.parse(s.end_utc);
      expect(ss < busyE && busyS < se).toBe(false);
    }
  });

  it("缺參數 → 422", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/availability?from=2027-05-03T00:00:00Z",
      headers: { authorization: `Bearer ${memberToken()}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it("無 token → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/availability?from=2027-05-03T00:00:00Z&to=2027-05-03T08:00:00Z&duration_minutes=30",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("Agent & MCP 管理端點 (api.md 31-35)", () => {
  it("member 呼叫 /v1/agents → 403（非 admin）", async () => {
    const res = await app.inject({
      method: "GET", url: "/v1/agents",
      headers: { authorization: `Bearer ${memberToken()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin 列 agent，含先前種下的 agent", async () => {
    const res = await app.inject({
      method: "GET", url: "/v1/agents",
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(200);
    const found = res.json().agents.find((a: { agent_id: string }) => a.agent_id === AGENT_ID);
    expect(found).toBeTruthy();
    expect(found.actions).toBeGreaterThan(0);
  });

  it("admin 撤銷 agent → 204，且再列時 revoked=true", async () => {
    const del = await app.inject({
      method: "DELETE", url: `/v1/agents/${AGENT_ID}/authorization`,
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({
      method: "GET", url: `/v1/agents/${AGENT_ID}`,
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(true);
  });

  it("admin 讀 agent 稽核活動（分頁）", async () => {
    const res = await app.inject({
      method: "GET", url: `/v1/agents/${AGENT_ID}/activity`,
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().entries)).toBe(true);
  });

  it("GET /v1/audit?actor_type=agent → 只回 agent 稽核", async () => {
    const res = await app.inject({
      method: "GET", url: "/v1/audit?actor_type=agent",
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries;
    expect(entries.every((e: { actor_type: string }) => e.actor_type === "agent")).toBe(true);
  });
});
