import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt } from "../src/auth/jwt.js";
import { remindersQueue } from "../src/reminders/queue.js";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS: string, CAL: string, MEM: string, EVENT: string;
const app = buildServer();

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  // ws-a 內可能有多個成員/行事曆（其他測試 fixture 留下的）。
  // 提醒端點有「本人隔離」核對（只有事件的行事曆擁有者或參與者看得到），
  // 故此處必須讓 MEM 就是 CAL 的擁有者，否則列表會（正確地）回 404。
  {
    const row = (
      await admin.query(
        `SELECT id, owner_id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`,
        [WS],
      )
    ).rows[0];
    CAL = row.id;
    MEM = row.owner_id;
  }
  // 單次事件（未來），供設提醒 → 會排 delayed job
  EVENT = (await admin.query(
    `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by)
     VALUES($1,$2,'RemRouteEvt','2999-06-01T06:00:00Z','2999-06-01T07:00:00Z','UTC',$3) RETURNING id`,
    [WS, CAL, MEM],
  )).rows[0].id;
  await admin.query(`DELETE FROM event_reminders WHERE event_id=$1`, [EVENT]);
  await admin.end();
  await app.ready();
});

afterAll(async () => {
  // 清掉本測試可能殘留的 delayed job（不關閉共享連線 — 由 reminders.test.ts 收尾，避免重複關閉）
  try {
    await remindersQueue.drain(true);
  } catch {
    /* 連線已被其他測試檔關閉則忽略 */
  }
});

const memberTok = () => signJwt({ sub: MEM, workspace: WS, roles: ["member"] });

describe("Reminders API (api.md 26-28, REM-*)", () => {
  it("無 token → 401", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/events/${EVENT}/reminders` });
    expect(res.statusCode).toBe(401);
  });

  it("事件不存在 → 404（列表）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/events/00000000-0000-0000-0000-000000000000/reminders",
      headers: { authorization: `Bearer ${memberTok()}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("設提醒 → 201，列表可見", async () => {
    const create = await app.inject({
      method: "POST", url: `/v1/events/${EVENT}/reminders`,
      headers: { authorization: `Bearer ${memberTok()}` },
      payload: { lead_minutes: 15, member_id: MEM, channel: "email" },
    });
    expect(create.statusCode).toBe(201);
    const reminder = create.json();
    expect(reminder.id).toBeTruthy();
    expect(reminder.lead_minutes).toBe(15);

    const list = await app.inject({
      method: "GET", url: `/v1/events/${EVENT}/reminders`,
      headers: { authorization: `Bearer ${memberTok()}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().reminders.some((r: { id: string }) => r.id === reminder.id)).toBe(true);
  });

  it("驗證失敗 → 422（lead_minutes 負數）", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/events/${EVENT}/reminders`,
      headers: { authorization: `Bearer ${memberTok()}` },
      payload: { lead_minutes: -5 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("移除提醒 → 204，其後列表不含", async () => {
    const create = await app.inject({
      method: "POST", url: `/v1/events/${EVENT}/reminders`,
      headers: { authorization: `Bearer ${memberTok()}` },
      payload: { lead_minutes: 30, member_id: MEM, channel: "push" },
    });
    const rid = create.json().id;

    const del = await app.inject({
      method: "DELETE", url: `/v1/events/${EVENT}/reminders/${rid}`,
      headers: { authorization: `Bearer ${memberTok()}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET", url: `/v1/events/${EVENT}/reminders`,
      headers: { authorization: `Bearer ${memberTok()}` },
    });
    expect(list.json().reminders.some((r: { id: string }) => r.id === rid)).toBe(false);
  });

  it("移除不存在的提醒 → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/events/${EVENT}/reminders/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${memberTok()}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
