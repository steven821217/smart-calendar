import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt } from "../src/auth/jwt.js";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS: string, WS_B: string, CAL: string, MEM: string, EVENT: string;
const app = buildServer();

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  WS_B = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-b'`)).rows[0].id;
  CAL = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  MEM = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  // 乾淨起點：清本測試資源/預訂
  await admin.query(`DELETE FROM resource_bookings WHERE workspace_id=$1`, [WS]);
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE 'RouteRoom%'`, [WS]);
  // 供預訂引用的事件
  EVENT = (await admin.query(
    `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by)
     VALUES($1,$2,'ResRouteEvt','2027-06-01T06:00:00Z','2027-06-01T07:00:00Z','UTC',$3) RETURNING id`,
    [WS, CAL, MEM],
  )).rows[0].id;
  await admin.end();
  await app.ready();
});

const adminTok = () => signJwt({ sub: MEM, workspace: WS, roles: ["admin"] });
const memberTok = () => signJwt({ sub: MEM, workspace: WS, roles: ["member"] });

describe("Resources API (api.md 22-25, REQ-R1/R2)", () => {
  it("無 token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/resources" });
    expect(res.statusCode).toBe(401);
  });

  it("member 建資源 → 403（非 admin/scheduler）", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/resources",
      headers: { authorization: `Bearer ${memberTok()}` },
      payload: { name: "RouteRoom-denied", type: "room" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin 建資源 → 201，member 可列到", async () => {
    const create = await app.inject({
      method: "POST", url: "/v1/resources",
      headers: { authorization: `Bearer ${adminTok()}` },
      payload: { name: "RouteRoom-1", type: "room", capacity: 8 },
    });
    expect(create.statusCode).toBe(201);
    const resource = create.json();
    expect(resource.id).toBeTruthy();
    expect(resource.name).toBe("RouteRoom-1");

    const list = await app.inject({
      method: "GET", url: "/v1/resources",
      headers: { authorization: `Bearer ${memberTok()}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().resources.some((r: { id: string }) => r.id === resource.id)).toBe(true);
  });

  it("建資料驗證失敗 → 422（空名稱）", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/resources",
      headers: { authorization: `Bearer ${adminTok()}` },
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("預訂成功 → 201，重疊時段再訂 → 409（防雙訂）", async () => {
    const created = await app.inject({
      method: "POST", url: "/v1/resources",
      headers: { authorization: `Bearer ${adminTok()}` },
      payload: { name: "RouteRoom-book", type: "room" },
    });
    const rid = created.json().id;

    const first = await app.inject({
      method: "POST", url: `/v1/resources/${rid}/bookings`,
      headers: { authorization: `Bearer ${adminTok()}` },
      payload: { event_id: EVENT, start_utc: "2027-06-01T06:00:00Z", end_utc: "2027-06-01T07:00:00Z" },
    });
    expect(first.statusCode).toBe(201);
    const bookingId = first.json().id;

    const clash = await app.inject({
      method: "POST", url: `/v1/resources/${rid}/bookings`,
      headers: { authorization: `Bearer ${adminTok()}` },
      payload: { event_id: EVENT, start_utc: "2027-06-01T06:30:00Z", end_utc: "2027-06-01T07:30:00Z" },
    });
    expect(clash.statusCode).toBe(409);

    // 取消 → 204，其後同時段可再訂
    const del = await app.inject({
      method: "DELETE", url: `/v1/resources/${rid}/bookings/${bookingId}`,
      headers: { authorization: `Bearer ${adminTok()}` },
    });
    expect(del.statusCode).toBe(204);

    const reuse = await app.inject({
      method: "POST", url: `/v1/resources/${rid}/bookings`,
      headers: { authorization: `Bearer ${adminTok()}` },
      payload: { event_id: EVENT, start_utc: "2027-06-01T06:00:00Z", end_utc: "2027-06-01T07:00:00Z" },
    });
    expect(reuse.statusCode).toBe(201);
  });

  it("取消不存在的預訂 → 404", async () => {
    const created = await app.inject({
      method: "POST", url: "/v1/resources",
      headers: { authorization: `Bearer ${adminTok()}` },
      payload: { name: "RouteRoom-404", type: "room" },
    });
    const rid = created.json().id;
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/resources/${rid}/bookings/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${adminTok()}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("跨 workspace 建的資源不可見（RLS）", async () => {
    // 在 ws-b 建資源，用 ws-a token 列表看不到
    const bAdminMem = MEM; // token sub 不影響 RLS（脈絡由 workspace claim 決定）
    const bTok = signJwt({ sub: bAdminMem, workspace: WS_B, roles: ["admin"] });
    const created = await app.inject({
      method: "POST", url: "/v1/resources",
      headers: { authorization: `Bearer ${bTok}` },
      payload: { name: "RouteRoom-wsb", type: "room" },
    });
    expect(created.statusCode).toBe(201);
    const bResourceId = created.json().id;

    const list = await app.inject({
      method: "GET", url: "/v1/resources",
      headers: { authorization: `Bearer ${adminTok()}` },
    });
    expect(list.json().resources.some((r: { id: string }) => r.id === bResourceId)).toBe(false);
  });
});
