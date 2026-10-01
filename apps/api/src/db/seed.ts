import pg from "pg";
import { hashPassword } from "../auth/password.js";

// seed 用 admin 連線（跨 workspace 建立示範資料，不受 RLS 限制以便建置 fixtures）
const adminUrl =
  process.env.ADMIN_DATABASE_URL ??
  `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`;

/**
 * 示範帳號密碼：以 SEED_DEMO_PASSWORD 覆寫。
 * ⚠️ 僅供本機／CI 示範資料使用；正式環境不應執行 seed，也不應沿用此密碼。
 */
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "demo-password-1234";
const TZ = "Asia/Taipei";

// ---- 相對日期工具：以「執行當下」為基準，讓 demo 資料永遠落在最近/未來 ----
// （避免寫死日期導致協作者啟動後 agent 查「這週/接下來」查不到東西）
const DAY = 24 * 60 * 60 * 1000;
function at(dayOffset: number, hhmmLocal: string): string {
  // 以 UTC 當基準日，加上 dayOffset 天，再套用台北時間的時分（台北 = UTC+8，無日光節約）。
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const [h, m] = hhmmLocal.split(":").map(Number);
  // 台北 09:00 == UTC 01:00
  const utcHour = h - 8;
  const d = new Date(base.getTime() + dayOffset * DAY);
  d.setUTCHours(utcHour, m, 0, 0);
  return d.toISOString();
}
// 找「本週一」相對今天的 offset（週一=1）。用於把重複會議錨在本週。
function mondayOffset(): number {
  const dow = new Date().getUTCDay(); // 0=Sun..6=Sat（以 UTC 粗略對齊，demo 足夠）
  return dow === 0 ? -6 : 1 - dow;
}

type Pg = pg.Client;

async function insUser(c: Pg, email: string, name: string, pw: string): Promise<string> {
  return (
    await c.query(
      `INSERT INTO users(email,display_name,password_hash) VALUES($1,$2,$3) RETURNING id`,
      [email, name, pw],
    )
  ).rows[0].id;
}
async function insWorkspace(c: Pg, name: string, slug: string): Promise<string> {
  return (
    await c.query(`INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id`, [name, slug])
  ).rows[0].id;
}
async function insMembership(
  c: Pg,
  ws: string,
  user: string,
  role: string,
  tz = TZ,
): Promise<string> {
  return (
    await c.query(
      `INSERT INTO memberships(workspace_id,user_id,role,timezone,working_hours)
       VALUES($1,$2,$3,$4,'{"mon":["09:00","18:00"],"tue":["09:00","18:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"],"fri":["09:00","18:00"]}'::jsonb)
       RETURNING id`,
      [ws, user, role, tz],
    )
  ).rows[0].id;
}
async function insCalendar(c: Pg, ws: string, owner: string, name: string): Promise<string> {
  return (
    await c.query(
      `INSERT INTO calendars(workspace_id,owner_id,name) VALUES($1,$2,$3) RETURNING id`,
      [ws, owner, name],
    )
  ).rows[0].id;
}
async function insEvent(
  c: Pg,
  ws: string,
  cal: string,
  creator: string,
  o: {
    title: string;
    start: string;
    end: string;
    location?: string;
    description?: string;
    rrule?: string;
  },
): Promise<string> {
  return (
    await c.query(
      `INSERT INTO events(workspace_id,calendar_id,title,description,start_utc,end_utc,timezone,location,rrule,created_by,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'app') RETURNING id`,
      [ws, cal, o.title, o.description ?? null, o.start, o.end, TZ, o.location ?? null, o.rrule ?? null, creator],
    )
  ).rows[0].id;
}
async function insParticipant(
  c: Pg,
  ws: string,
  event: string,
  member: string,
  rsvp: "pending" | "accepted" | "declined",
  isOrganizer = false,
): Promise<void> {
  const response =
    rsvp === "accepted" ? "accepted" : rsvp === "declined" ? "declined" : "needs_action";
  await c.query(
    `INSERT INTO event_participants(workspace_id,event_id,member_id,response_status,is_organizer,rsvp_status)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [ws, event, member, response, isOrganizer, rsvp],
  );
}
async function insGroup(c: Pg, ws: string, name: string, creator: string): Promise<string> {
  return (
    await c.query(
      `INSERT INTO groups(workspace_id,name,created_by) VALUES($1,$2,$3) RETURNING id`,
      [ws, name, creator],
    )
  ).rows[0].id;
}
async function insGroupMember(
  c: Pg,
  ws: string,
  group: string,
  user: string,
  role: "leader" | "member",
): Promise<void> {
  await c.query(
    `INSERT INTO group_members(workspace_id,group_id,user_id,role) VALUES($1,$2,$3,$4)`,
    [ws, group, user, role],
  );
}
async function insResource(
  c: Pg,
  ws: string,
  name: string,
  type: "room" | "equipment",
  capacity?: number,
): Promise<string> {
  return (
    await c.query(
      `INSERT INTO resources(workspace_id,name,type,capacity) VALUES($1,$2,$3,$4) RETURNING id`,
      [ws, name, type, capacity ?? null],
    )
  ).rows[0].id;
}
async function insReminder(c: Pg, ws: string, event: string, member: string, lead: number) {
  await c.query(
    `INSERT INTO event_reminders(workspace_id,event_id,member_id,lead_minutes,channel) VALUES($1,$2,$3,$4,'email')`,
    [ws, event, member, lead],
  );
}

// ---- 示範帳號清單（供清理用，冪等）----
const DEMO_EMAILS = [
  "a@example.com",
  "b@example.com",
  "alice@example.com",
  "bob@example.com",
  "carol@example.com",
  "dave@example.com",
  "erin@example.com",
];
const DEMO_SLUGS = ["ws-a", "ws-b"];

async function main() {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const pw = await hashPassword(DEMO_PASSWORD);
    await c.query("BEGIN");

    // 冪等：先清除所有示範資料（workspace CASCADE 會連帶清 memberships/events/... ）
    await c.query(`DELETE FROM workspaces WHERE slug = ANY($1)`, [DEMO_SLUGS]);
    await c.query(`DELETE FROM users WHERE email = ANY($1)`, [DEMO_EMAILS]);

    // =========================================================
    // Workspace A：「Acme 產品部」—— 豐富示範情境（多成員/群組/會議/RSVP/資源）
    // =========================================================
    const wsA = await insWorkspace(c, "Acme 產品部", "ws-a");

    // 使用者 + membership（a 為 admin，其餘為團隊成員，分散時區展示跨區排程）
    const uAdmin = await insUser(c, "a@example.com", "Admin Amy", pw);
    const uAlice = await insUser(c, "alice@example.com", "Alice Chen", pw);
    const uBob = await insUser(c, "bob@example.com", "Bob Lin", pw);
    const uCarol = await insUser(c, "carol@example.com", "Carol Wu", pw);
    const uDave = await insUser(c, "dave@example.com", "Dave Huang", pw);

    const mAdmin = await insMembership(c, wsA, uAdmin, "admin", TZ);
    const mAlice = await insMembership(c, wsA, uAlice, "scheduler", TZ);
    const mBob = await insMembership(c, wsA, uBob, "member", TZ);
    const mCarol = await insMembership(c, wsA, uCarol, "member", "America/Los_Angeles");
    const mDave = await insMembership(c, wsA, uDave, "member", TZ);

    const calA = await insCalendar(c, wsA, mAdmin, "Acme 產品部 共享日曆");

    // 群組：Alpha 小隊 / 產品團隊（示範 group 核心詞覆核 & leader 代排）
    const gAlpha = await insGroup(c, wsA, "Alpha 小隊", mAdmin);
    const gProduct = await insGroup(c, wsA, "產品團隊", mAdmin);
    await insGroupMember(c, wsA, gAlpha, uAlice, "leader");
    await insGroupMember(c, wsA, gAlpha, uBob, "member");
    await insGroupMember(c, wsA, gAlpha, uCarol, "member");
    await insGroupMember(c, wsA, gProduct, uAdmin, "leader");
    await insGroupMember(c, wsA, gProduct, uAlice, "member");
    await insGroupMember(c, wsA, gProduct, uBob, "member");
    await insGroupMember(c, wsA, gProduct, uDave, "member");

    // 資源：會議室 + 公務車（equipment=需交接）
    const resRoom = await insResource(c, wsA, "大會議室", "room", 12);
    const resCar = await insResource(c, wsA, "公務車 A", "equipment", 4);

    const mon = mondayOffset();

    // --- 事件群 ---
    // 1) 每週一 09:30 team standup（重複事件，錨在本週一）
    const evStandup = await insEvent(c, wsA, calA, mAdmin, {
      title: "每週團隊同步 Standup",
      description: "各組進度同步，15 分鐘站立會議。",
      start: at(mon, "09:30"),
      end: at(mon, "09:45"),
      location: "大會議室",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
    await insParticipant(c, wsA, evStandup, mAdmin, "accepted", true);
    await insParticipant(c, wsA, evStandup, mAlice, "accepted");
    await insParticipant(c, wsA, evStandup, mBob, "accepted");
    await insReminder(c, wsA, evStandup, mAdmin, 10);

    // 2) 今天下午的產品評審（含參與者，部分待回覆）
    const evReview = await insEvent(c, wsA, calA, mAlice, {
      title: "產品需求評審",
      description: "Q3 功能範圍討論與排序。",
      start: at(0, "14:00"),
      end: at(0, "15:00"),
      location: "大會議室",
    });
    await insParticipant(c, wsA, evReview, mAlice, "accepted", true);
    await insParticipant(c, wsA, evReview, mBob, "accepted");
    await insParticipant(c, wsA, evReview, mCarol, "pending");
    await insReminder(c, wsA, evReview, mAlice, 30);

    // 3) 明天上午：與客戶視訊
    const evClient = await insEvent(c, wsA, calA, mAdmin, {
      title: "客戶 Kickoff 視訊",
      description: "新專案啟動會議。",
      start: at(1, "10:00"),
      end: at(1, "11:00"),
      location: "線上 (Google Meet)",
    });
    await insParticipant(c, wsA, evClient, mAdmin, "accepted", true);
    await insParticipant(c, wsA, evClient, mAlice, "accepted");

    // 4) 後天：公務車外出拜訪（含 resource booking，示範交接 buffer）
    const evVisit = await insEvent(c, wsA, calA, mBob, {
      title: "客戶現場拜訪",
      description: "出差拜訪客戶，使用公務車 A。",
      start: at(2, "13:00"),
      end: at(2, "17:00"),
      location: "客戶辦公室",
    });
    await insParticipant(c, wsA, evVisit, mBob, "accepted", true);
    await c.query(
      `INSERT INTO resource_bookings(workspace_id,resource_id,event_id,start_utc,end_utc)
       VALUES($1,$2,$3,$4,$5)`,
      [wsA, resCar, evVisit, at(2, "12:45"), at(2, "17:15")], // 含前後 15 分交接 buffer
    );
    await insReminder(c, wsA, evVisit, mBob, 30);

    // 5) 下週一：Leader 幫 Alpha 小隊排的會議（成員 RSVP 待回覆 → 示範委派審批）
    const evTeam = await insEvent(c, wsA, calA, mAlice, {
      title: "Alpha 小隊 衝刺規劃",
      description: "下個 sprint 的任務分派，Leader 代排、成員待確認。",
      start: at(mon + 7, "15:00"),
      end: at(mon + 7, "16:30"),
      location: "大會議室",
    });
    await insParticipant(c, wsA, evTeam, mAlice, "accepted", true);
    await insParticipant(c, wsA, evTeam, mBob, "pending");
    await insParticipant(c, wsA, evTeam, mCarol, "pending");

    // 6) 本週五：Carol（LA 時區）的一對一
    const ev1on1 = await insEvent(c, wsA, calA, mAdmin, {
      title: "Carol 1:1",
      description: "季度回顧與職涯討論。",
      start: at(mon + 4, "09:00"),
      end: at(mon + 4, "09:30"),
      location: "線上",
    });
    await insParticipant(c, wsA, ev1on1, mAdmin, "accepted", true);
    await insParticipant(c, wsA, ev1on1, mCarol, "accepted");

    // 7) Dave 的個人 focus time（只有自己）
    await insEvent(c, wsA, calA, mDave, {
      title: "Deep Work（勿擾）",
      description: "專注開發，請勿安排會議。",
      start: at(1, "15:00"),
      end: at(1, "17:00"),
    });

    // =========================================================
    // Workspace B：隔離對照組（獨立租戶，資料不應被 A 看到）
    // =========================================================
    const wsB = await insWorkspace(c, "Beta 工作室", "ws-b");
    const uB = await insUser(c, "b@example.com", "Admin Ben", pw);
    const uErin = await insUser(c, "erin@example.com", "Erin Su", pw);
    const mB = await insMembership(c, wsB, uB, "admin", TZ);
    const mErin = await insMembership(c, wsB, uErin, "member", TZ);
    const calB = await insCalendar(c, wsB, mB, "Beta 工作室 日曆");
    const gBeta = await insGroup(c, wsB, "Beta 核心", mB);
    await insGroupMember(c, wsB, gBeta, uB, "leader");
    await insGroupMember(c, wsB, gBeta, uErin, "member");

    const evB1 = await insEvent(c, wsB, calB, mB, {
      title: "Beta 週會",
      start: at(mon + 2, "11:00"),
      end: at(mon + 2, "12:00"),
      location: "Beta 會議室",
    });
    await insParticipant(c, wsB, evB1, mB, "accepted", true);
    await insParticipant(c, wsB, evB1, mErin, "accepted");
    await insEvent(c, wsB, calB, mErin, {
      title: "設計評審",
      start: at(1, "16:00"),
      end: at(1, "17:00"),
    });

    await c.query("COMMIT");
    console.log(
      "seed: OK",
      JSON.stringify({
        "ws-a": { workspace: wsA, users: 5, groups: 2, events: 7, resources: 2 },
        "ws-b": { workspace: wsB, users: 2, groups: 1, events: 2 },
        demo_login: { emails: DEMO_EMAILS, password: "<SEED_DEMO_PASSWORD>" },
      }),
    );
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("seed FAILED:", e);
  process.exit(1);
});
