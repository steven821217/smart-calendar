import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt, verifyJwt } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createEvent } from "../src/events/service.js";

/**
 * 「把已註冊使用者加入工作區」＋「日曆個人隔離」＋「跨工作區登入」。
 *
 * 鎖住的性質：
 *  1. POST /v1/members：admin 可用 email 加入**已註冊**的人；未註冊 → 404；重複 → 409；非 admin → 403。
 *  2. 加入後 member **看不到** leader 私人行程（GET /v1/events 個人隔離），
 *     但**看得到**自己被列為參與者的會（leader / agent 幫團隊排的，pending 或 accepted 皆可見）。
 *  3. 一個人屬於多個工作區時：登入未指定 workspace → 回清單且**不發 token**；
 *     指定後才發該 workspace 的 token；switch-workspace 可換且僅限本人的 membership。
 */

const PASSWORD = "member-flow-password";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;
let WS_LEADER: string; // leader 的工作區
let LEADER_MEM: string;
let LEADER_CAL: string;
let MEMBER_MEM: string; // 被加入後在 leader 工作區的 membership
let WS_MEMBER_OWN: string; // member 自己註冊的工作區

const LEADER_EMAIL = "mf-leader@example.com";
const MEMBER_EMAIL = "mf-member@example.com";
const GHOST_EMAIL = "mf-ghost@example.com"; // 從未註冊

async function cleanup() {
  const c = adminClient();
  await c.connect();
  await c.query(
    `DELETE FROM workspaces WHERE id IN (
       SELECT m.workspace_id FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE u.email = ANY($1)
     )`,
    [[LEADER_EMAIL, MEMBER_EMAIL]],
  );
  await c.query(`DELETE FROM users WHERE email = ANY($1)`, [[LEADER_EMAIL, MEMBER_EMAIL, GHOST_EMAIL]]);
  await c.end();
}

beforeAll(async () => {
  await cleanup();
  process.env.LOGIN_THROTTLE = "0";
  app = buildServer();
  await app.ready();

  // 兩個人各自「自己註冊」（各自建立一個工作區）
  const reg = async (email: string, name: string, wsName: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: PASSWORD, display_name: name, workspace_name: wsName, timezone: "Asia/Taipei" },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  const leader = await reg(LEADER_EMAIL, "MF Leader", "MF Leader 團隊");
  const member = await reg(MEMBER_EMAIL, "MF Member", "MF Member 自己的空間");
  WS_LEADER = leader.me.workspace.id;
  LEADER_MEM = leader.me.membership_id;
  WS_MEMBER_OWN = member.me.workspace.id;

  const c = adminClient();
  await c.connect();
  LEADER_CAL = (
    await c.query(`SELECT id FROM calendars WHERE workspace_id=$1 LIMIT 1`, [WS_LEADER])
  ).rows[0].id;
  await c.end();
});

afterAll(async () => {
  await app.close();
  await cleanup();
});

const leaderToken = () => signJwt({ sub: LEADER_MEM, workspace: WS_LEADER, roles: ["admin"] });

describe("POST /v1/members：把已註冊的人加入工作區", () => {
  it("未註冊的 email → 404（要求對方先自行註冊）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: { authorization: `Bearer ${leaderToken()}` },
      payload: { email: GHOST_EMAIL, role: "member" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toContain("註冊");
  });

  it("已註冊 → 201，並在該工作區取得 membership 與個人日曆", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: { authorization: `Bearer ${leaderToken()}` },
      payload: { email: MEMBER_EMAIL, role: "member", timezone: "Asia/Taipei" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe("member");
    MEMBER_MEM = body.membership_id;

    const c = adminClient();
    await c.connect();
    const cal = await c.query(`SELECT count(*)::int AS n FROM calendars WHERE owner_id=$1`, [MEMBER_MEM]);
    await c.end();
    expect(cal.rows[0].n).toBe(1);
  });

  it("重複加入 → 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: { authorization: `Bearer ${leaderToken()}` },
      payload: { email: MEMBER_EMAIL, role: "member" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("非 admin（member 角色）→ 403", async () => {
    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { email: GHOST_EMAIL, role: "member" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /v1/events：個人隔離（加入工作區 ≠ 看得到 leader 的日曆）", () => {
  const FROM = "2027-03-01T00:00:00Z";
  const TO = "2027-03-08T00:00:00Z";
  const titles = async (token: string) => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/events?from=${FROM}&to=${TO}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().occurrences as Array<{ title: string }>).map((o) => o.title);
  };

  it("leader 的私人行程：leader 看得到、member 看不到", async () => {
    await createEvent(WS_LEADER, {
      calendar_id: LEADER_CAL,
      title: "MF-LEADER-私人",
      start_utc: "2027-03-02T01:00:00Z",
      end_utc: "2027-03-02T02:00:00Z",
      timezone: "Asia/Taipei",
      created_by: LEADER_MEM,
    } as never);

    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    expect(await titles(leaderToken())).toContain("MF-LEADER-私人");
    expect(await titles(memberToken)).not.toContain("MF-LEADER-私人");
  });

  it("leader 幫 member 排的會（member 為參與者）：雙方都看得到，pending 也可見", async () => {
    const ev = await createEvent(WS_LEADER, {
      calendar_id: LEADER_CAL,
      title: "MF-團隊會議",
      start_utc: "2027-03-03T01:00:00Z",
      end_utc: "2027-03-03T02:00:00Z",
      timezone: "Asia/Taipei",
      created_by: LEADER_MEM,
    } as never);

    const c = adminClient();
    await c.connect();
    await c.query(
      `INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status)
       VALUES($1,$2,$3,'pending')`,
      [WS_LEADER, ev.id, MEMBER_MEM],
    );

    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    expect(await titles(memberToken)).toContain("MF-團隊會議"); // pending 即可見（收件匣要用）

    // accept 之後仍看得到
    await c.query(`UPDATE event_participants SET rsvp_status='accepted' WHERE event_id=$1 AND member_id=$2`, [
      ev.id,
      MEMBER_MEM,
    ]);
    await c.end();
    expect(await titles(memberToken)).toContain("MF-團隊會議");
    expect(await titles(leaderToken())).toContain("MF-團隊會議");
  });
});

describe("寫入隔離：不能把事件建到別人的行事曆", () => {
  it("GET /v1/calendars 只回本人擁有的行事曆", async () => {
    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const asMember = await app.inject({
      method: "GET",
      url: "/v1/calendars",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(asMember.statusCode).toBe(200);
    const mine = asMember.json().calendars as Array<{ id: string; owner_id: string }>;
    expect(mine.length).toBe(1);
    expect(mine[0].owner_id).toBe(MEMBER_MEM);
    expect(mine.map((c) => c.id)).not.toContain(LEADER_CAL); // 看不到 leader 的行事曆
  });

  it("member 指定 leader 的 calendar_id 建事件 → 404（不洩漏存在性）", async () => {
    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {
        calendar_id: LEADER_CAL,
        title: "MF-偷寫進組長日曆",
        start_utc: "2027-03-05T01:00:00Z",
        end_utc: "2027-03-05T02:00:00Z",
        timezone: "Asia/Taipei",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("在自己的行事曆上建事件 → 201", async () => {
    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const cals = await app.inject({
      method: "GET",
      url: "/v1/calendars",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    const myCal = (cals.json().calendars as Array<{ id: string }>)[0].id;
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {
        calendar_id: myCal,
        title: "MF-我自己的事",
        start_utc: "2027-03-06T01:00:00Z",
        end_utc: "2027-03-06T02:00:00Z",
        timezone: "Asia/Taipei",
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("讀取隔離：單筆事件與提醒不得因 visibility='busy' 而全都露", () => {
  let leaderEventId: string;

  it("member 用 event id 直接讀 leader 的事件 → 404（不因 busy 而回完整內容）", async () => {
    const ev = await createEvent(WS_LEADER, {
      calendar_id: LEADER_CAL,
      title: "MF-機密一對一",
      description: "薪資討論",
      location: "小會議室",
      start_utc: "2027-03-10T01:00:00Z",
      end_utc: "2027-03-10T02:00:00Z",
      timezone: "Asia/Taipei",
      created_by: LEADER_MEM,
    } as never);
    leaderEventId = ev.id;
    expect(ev.visibility).toBe("busy"); // 預設值，正是 OPA 放行的那個

    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "GET",
      url: `/v1/events/${leaderEventId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("薪資討論");
    expect(res.body).not.toContain("MF-機密一對一");
  });

  it("leader 自己讀得到（未因修正而壞掉）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/events/${leaderEventId}`,
      headers: { authorization: `Bearer ${leaderToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("MF-機密一對一");
  });

  it("member 讀不到 leader 事件的提醒設定 → 404", async () => {
    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "GET",
      url: `/v1/events/${leaderEventId}/reminders`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("身為參與者則讀得到（leader 幫團隊排的會）", async () => {
    const ev = await createEvent(WS_LEADER, {
      calendar_id: LEADER_CAL,
      title: "MF-可見的團隊會",
      start_utc: "2027-03-11T01:00:00Z",
      end_utc: "2027-03-11T02:00:00Z",
      timezone: "Asia/Taipei",
      created_by: LEADER_MEM,
    } as never);
    const c = adminClient();
    await c.connect();
    await c.query(
      `INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status)
       VALUES($1,$2,$3,'pending')`,
      [WS_LEADER, ev.id, MEMBER_MEM],
    );
    await c.end();

    const memberToken = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "GET",
      url: `/v1/events/${ev.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("MF-可見的團隊會");
  });
});

describe("跨工作區登入與切換", () => {
  it("屬於多個工作區且未指定 → 回清單且不發 token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: MEMBER_EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.needs_workspace_selection).toBe(true);
    expect(body.access_token).toBeUndefined();
    const ids = (body.workspaces as Array<{ id: string }>).map((w) => w.id);
    expect(ids).toContain(WS_LEADER);
    expect(ids).toContain(WS_MEMBER_OWN);
  });

  it("指定 workspace_id → 發該 workspace 的 token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: MEMBER_EMAIL, password: PASSWORD, workspace_id: WS_LEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expires_in).toBe(3600);
    const claims = verifyJwt(`Bearer ${res.json().access_token}`);
    expect(claims!.workspace).toBe(WS_LEADER);
    expect(claims!.roles).toEqual(["member"]); // 在 leader 工作區的角色
  });

  it("指定不屬於自己的 workspace → 401（不洩漏存在性）", async () => {
    const c = adminClient();
    await c.connect();
    const other = (await c.query(`SELECT id FROM workspaces WHERE slug='ws-a' LIMIT 1`)).rows[0].id;
    await c.end();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: MEMBER_EMAIL, password: PASSWORD, workspace_id: other },
    });
    expect(res.statusCode).toBe(401);
  });

  it("只屬於一個工作區 → 直接發 token（不需選擇）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: LEADER_EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBeTruthy();
  });

  it("GET /v1/auth/workspaces 列出本人所有工作區", async () => {
    const token = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().current_workspace_id).toBe(WS_LEADER);
    expect((res.json().workspaces as unknown[]).length).toBe(2);
  });

  it("switch-workspace 換到自己的另一個工作區", async () => {
    const token = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/switch-workspace",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: WS_MEMBER_OWN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expires_in).toBe(3600);
    const claims = verifyJwt(`Bearer ${res.json().access_token}`);
    expect(claims!.workspace).toBe(WS_MEMBER_OWN);
    expect(claims!.roles).toEqual(["admin"]); // 自己註冊的工作區是 admin
  });

  it("switch-workspace 到不屬於自己的工作區 → 404", async () => {
    const c = adminClient();
    await c.connect();
    const other = (await c.query(`SELECT id FROM workspaces WHERE slug='ws-a' LIMIT 1`)).rows[0].id;
    await c.end();
    const token = signJwt({ sub: MEMBER_MEM, workspace: WS_LEADER, roles: ["member"] });
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/switch-workspace",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: other },
    });
    expect(res.statusCode).toBe(404);
  });

  it("agent token 不得切換工作區 → 403", async () => {
    const agentJwt = signJwt({
      sub: "mf-agent",
      workspace: WS_LEADER,
      roles: ["member"],
      scope: ["availability.read"],
      user_sub: MEMBER_MEM,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/switch-workspace",
      headers: { authorization: `Bearer ${agentJwt}` },
      payload: { workspace_id: WS_MEMBER_OWN },
    });
    expect(res.statusCode).toBe(403);
  });
});

/** 保留：hashPassword 於此檔未直接用到，但註冊流程依賴它（避免未用匯入警告）。 */
void hashPassword;
