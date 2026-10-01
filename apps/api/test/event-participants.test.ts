import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";

/**
 * 事件與會者（邀請 + 顯示）。
 *
 * 起因：`EventInput` 早就接受 `participants`，但服務層完全忽略它——API 看起來收下了
 * 邀請卻默默丟掉；而且沒有任何讀取端點會回傳與會者，所以站內看不到「這場會有誰參加」。
 *
 * 鎖住的性質：
 *  - 建立事件時帶 participants → 真的寫進去（不可再默默丟掉）
 *  - 建立者為 is_organizer 且 accepted；被邀請的人為 pending
 *  - GET /v1/events/:id 回傳與會者名單（含姓名與回覆狀態）
 *  - 被邀請的人會在自己的待回覆清單看到這場會（RSVP 流程才成立）
 *  - PUT participants 是取代語意，但**發起人不可被移除**、**已回覆者不被重設**
 *  - 只有發起人能改與會者（否則任何人都能把別人塞進別人的會議）
 */

interface EventParticipantJson {
  member_id: string | null;
  guest_email: string | null;
  display_name: string | null;
  rsvp_status: string;
  is_organizer: boolean;
}

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;
const EMAILS = ["party-host@example.com", "party-guest@example.com"];
let hostToken = "";
let guestToken = "";
let hostCalendar = "";
let guestMembership = "";

async function cleanup() {
  const c = adminClient();
  await c.connect();
  await c.query(
    `DELETE FROM workspaces WHERE id IN (
       SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ANY($1)
     )`,
    [EMAILS],
  );
  await c.query(`DELETE FROM users WHERE email = ANY($1)`, [EMAILS]);
  await c.end();
}

beforeAll(async () => {
  await cleanup();
  app = buildServer();
  await app.ready();

  // host 註冊一個 workspace
  const reg = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: EMAILS[0],
      password: "party-host-pass-1234",
      display_name: "主辦人",
      workspace_name: "與會者測試",
    },
  });
  expect(reg.statusCode).toBe(201);
  hostToken = (reg.json() as { access_token: string }).access_token;

  // guest 先自己註冊（加入既有 workspace 需要對方已有帳號）
  const reg2 = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: EMAILS[1],
      password: "party-guest-pass-1234",
      display_name: "受邀人",
      workspace_name: "受邀人自己的空間",
    },
  });
  expect(reg2.statusCode).toBe(201);

  // host 把 guest 加進自己的 workspace
  const add = await app.inject({
    method: "POST",
    url: "/v1/members",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { email: EMAILS[1], role: "member" },
  });
  expect([200, 201]).toContain(add.statusCode);

  // 取 guest 的 membership_id 與 host 的 calendar
  const members = await app.inject({
    method: "GET",
    url: "/v1/members",
    headers: { authorization: `Bearer ${hostToken}` },
  });
  const rows = (members.json() as { members: Array<{ membership_id: string; display_name: string }> })
    .members;
  guestMembership = rows.find((m) => m.display_name === "受邀人")!.membership_id;

  const cals = await app.inject({
    method: "GET",
    url: "/v1/calendars",
    headers: { authorization: `Bearer ${hostToken}` },
  });
  const calList = cals.json() as { calendars?: Array<{ id: string }> } | Array<{ id: string }>;
  hostCalendar = Array.isArray(calList) ? calList[0].id : calList.calendars![0].id;

  // guest 登入（需選 workspace：他有自己的 + 被加入的）
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: EMAILS[1], password: "party-guest-pass-1234" },
  });
  const body = login.json() as {
    access_token?: string;
    workspaces?: Array<{ id: string; name: string }>;
  };
  if (body.access_token) {
    guestToken = body.access_token;
  } else {
    const target = body.workspaces!.find((w) => w.name === "與會者測試")!;
    const picked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: EMAILS[1], password: "party-guest-pass-1234", workspace_id: target.id },
    });
    guestToken = (picked.json() as { access_token: string }).access_token;
  }
});

afterAll(async () => {
  await app.close();
  await cleanup();
});

async function createEventWithGuests(memberIds: string[]) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: {
      calendar_id: hostCalendar,
      title: "專案啟動會",
      start_utc: "2026-12-01T02:00:00.000Z",
      end_utc: "2026-12-01T03:00:00.000Z",
      timezone: "Asia/Taipei",
      participants: memberIds.map((id) => ({ member_id: id })),
    },
  });
  return res;
}

describe("事件與會者", () => {
  it("建立時帶 participants → 真的寫入，且發起人 accepted、受邀人 pending", async () => {
    const res = await createEventWithGuests([guestMembership]);
    expect(res.statusCode).toBe(201);
    const ev = res.json() as {
      id: string;
      participants: Array<{ display_name: string | null; rsvp_status: string; is_organizer: boolean }>;
    };
    // 關鍵回歸點：先前這裡會是 undefined（邀請被默默丟掉）
    expect(ev.participants, "建立回應必須含與會者").toBeDefined();
    const host = ev.participants.find((p) => p.is_organizer);
    const guest = ev.participants.find((p) => !p.is_organizer);
    expect(host?.display_name).toBe("主辦人");
    expect(host?.rsvp_status).toBe("accepted");
    expect(guest?.display_name).toBe("受邀人");
    expect(guest?.rsvp_status).toBe("pending");

    // 讀取端點也要回傳
    const got = await app.inject({
      method: "GET",
      url: `/v1/events/${ev.id}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { participants: unknown[] }).participants).toHaveLength(2);

    // 受邀人會在待回覆清單看到
    const pending = await app.inject({
      method: "GET",
      url: "/v1/me/pending-rsvps",
      headers: { authorization: `Bearer ${guestToken}` },
    });
    expect(pending.statusCode).toBe(200);
    const titles = (pending.json() as { pending: Array<{ title: string }> }).pending.map((p) => p.title);
    expect(titles).toContain("專案啟動會");
  });

  it("PUT 取代名單：發起人不可被移除；已回覆者狀態不被重設", async () => {
    const created = await createEventWithGuests([guestMembership]);
    const id = (created.json() as { id: string }).id;

    // 模擬受邀人已接受
    const c = adminClient();
    await c.connect();
    await c.query(`UPDATE event_participants SET rsvp_status='accepted' WHERE event_id=$1 AND is_organizer=false`, [id]);
    await c.end();

    // 重新送一次同樣的名單（等同再次編輯事件）
    const put = await app.inject({
      method: "PUT",
      url: `/v1/events/${id}/participants`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { member_ids: [guestMembership] },
    });
    expect(put.statusCode).toBe(200);
    const after = (put.json() as { participants: Array<{ is_organizer: boolean; rsvp_status: string }> })
      .participants;
    // 已接受的不可被打回 pending
    expect(after.find((p) => !p.is_organizer)?.rsvp_status).toBe("accepted");

    // 清空名單 → 只剩發起人，且發起人仍在
    const cleared = await app.inject({
      method: "PUT",
      url: `/v1/events/${id}/participants`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { member_ids: [] },
    });
    const left = (cleared.json() as { participants: Array<{ is_organizer: boolean }> }).participants;
    expect(left).toHaveLength(1);
    expect(left[0].is_organizer).toBe(true);
  });

  it("用 email 邀請：屬於本工作區的 email 連到其成員身分，而非外部訪客", async () => {
    const created = await createEventWithGuests([]);
    const id = (created.json() as { id: string }).id;
    const put = await app.inject({
      method: "PUT",
      url: `/v1/events/${id}/participants`,
      headers: { authorization: `Bearer ${hostToken}` },
      // 故意用大小寫混雜，確認比對不分大小寫
      payload: { member_ids: [], guest_emails: ["Party-Guest@Example.com"] },
    });
    expect(put.statusCode).toBe(200);
    const ps = (put.json() as { participants: EventParticipantJson[] }).participants;
    const guest = ps.find((p) => !p.is_organizer);
    // 關鍵：必須連到成員（有 member_id 與姓名），否則對方收不到站內待回覆邀請
    expect(guest?.member_id, "工作區成員的 email 應連到其成員身分").toBeTruthy();
    expect(guest?.display_name).toBe("受邀人");
    expect(guest?.guest_email).toBeNull();
    expect(guest?.rsvp_status).toBe("pending");

    // 受邀人在站內看得到
    const pending = await app.inject({
      method: "GET",
      url: "/v1/me/pending-rsvps",
      headers: { authorization: `Bearer ${guestToken}` },
    });
    const titles = (pending.json() as { pending: Array<{ event_id: string }> }).pending.map(
      (p) => p.event_id,
    );
    expect(titles).toContain(id);
  });

  it("email 對不到工作區成員 → 422，且不會留下半套資料", async () => {
    const created = await createEventWithGuests([]);
    const id = (created.json() as { id: string }).id;
    // 平台上的人都以 email 註冊，所以對不到就是打錯或對方沒加入工作區。
    // 先前的行為是建立一筆 guest 列——對方沒有站內帳號、看不到待回覆清單，
    // 又沒有寄信，等於安靜地什麼都沒發生。必須明確報錯。
    const res = await app.inject({
      method: "PUT",
      url: `/v1/events/${id}/participants`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { member_ids: [], guest_emails: ["nobody@elsewhere.example.com"] },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { detail: string }).detail).toContain("nobody@elsewhere.example.com");
    // 名單沒有被改壞：仍只有發起人
    const after = await app.inject({
      method: "GET",
      url: `/v1/events/${id}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    const ps = (after.json() as { participants: EventParticipantJson[] }).participants;
    expect(ps).toHaveLength(1);
    expect(ps[0].is_organizer).toBe(true);
  });

  it("建立事件時 email 對不到 → 422，且不留下孤兒事件（全有或全無）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {
        calendar_id: hostCalendar,
        title: "不該被建立的會議",
        start_utc: "2026-12-05T02:00:00.000Z",
        end_utc: "2026-12-05T03:00:00.000Z",
        timezone: "Asia/Taipei",
        participants: [{ guest_email: "ghost@elsewhere.example.com" }],
      },
    });
    expect(res.statusCode).toBe(422);
    // 事件本身也不該留下——否則使用者看到「建立失敗」但月曆上多一場沒邀到人的會
    const list = await app.inject({
      method: "GET",
      url: "/v1/events?from=2026-12-04T00:00:00.000Z&to=2026-12-06T00:00:00.000Z",
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(JSON.stringify(list.json())).not.toContain("不該被建立的會議");
  });

  it("GET /v1/members/by-email：找得到成員；查不到回 404 並給可行動訊息", async () => {
    const ok = await app.inject({
      method: "GET",
      url: `/v1/members/by-email?email=${encodeURIComponent("PARTY-GUEST@example.com")}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { member: { display_name: string } }).member.display_name).toBe("受邀人");

    const miss = await app.inject({
      method: "GET",
      url: "/v1/members/by-email?email=nobody@elsewhere.example.com",
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(miss.statusCode).toBe(404);
    expect((miss.json() as { detail: string }).detail).toContain("團隊群組");
  });

  it("非發起人不能改與會者", async () => {
    const created = await createEventWithGuests([guestMembership]);
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PUT",
      url: `/v1/events/${id}/participants`,
      headers: { authorization: `Bearer ${guestToken}` },
      payload: { member_ids: [] },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});
