/**
 * 回歸評測用固定資料（fixtures）。
 *
 * 目的：讓同一批題目在任何版本、任何執行日都能重現。所有事件都以「今天」為基準的相對日產生。
 *
 * 不變式（fixture v2 起）：
 *   - 今天 / 明天 / 後天 / 下週一 的事件**完全不動**，因為既有題目以它們為錨點。
 *   - 「產品團隊」永遠是空的（測「尚無成員」）。
 *   - 「Alpha 小隊」永遠包含林小明。
 *   - 新增的豐富資料只放在 +3 天之後，避免影響既有期望值。
 *   - 跟資料量綁定的期望值（幾場會、幾個人）由本檔算出後寫入 ctx.counts，
 *     題庫改讀 ctx，資料再擴充時不會默默失準。
 *
 * 產物寫到 eval/.ctx.json（被 git 忽略），內含外部 agent 的 OAuth token 與 workspace id。
 */
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { CTX_PATH, PRIVATE_EVENT_TITLES } from "./config.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = process.env.EVAL_BASE_URL || "https://127.0.0.1:9443";
const DB_CONTAINER = process.env.EVAL_DB_CONTAINER || "smart-calendar-db-1";
const REDIS_CONTAINER = process.env.EVAL_REDIS_CONTAINER || "smart-calendar-redis-1";
const DB_NAME = process.env.DB_NAME || "calendar";

export const FIXTURE_VERSION = "v2-multi-team";

const stamp = Date.now();
const LEADER = { email: `eval-lead-${stamp}@example.com`, pw: "eval-leader-pass-1234", name: "陳組長", ws: `EVAL 行銷部 ${stamp}` };

/** 團隊成員。第一位是既有題目依賴的林小明，其餘為 fixture v2 新增。 */
const PEOPLE = [
  { key: "ming", name: "林小明", pw: "eval-member-pass-1234" },
  { key: "dawen", name: "王大文", pw: "eval-dawen-pass-1234" },
  { key: "meiling", name: "張美玲", pw: "eval-meiling-pass-1234" },
  { key: "guoqiang", name: "李國強", pw: "eval-guoqiang-pass-1234" },
  { key: "yating", name: "周雅婷", pw: "eval-yating-pass-1234" },
  { key: "jianhong", name: "吳建宏", pw: "eval-jianhong-pass-1234" },
];

/** 團隊組成：刻意有空團隊、單人團隊、多人團隊，以及跨團隊成員（周雅婷、吳建宏）。 */
const GROUPS = [
  { name: "Alpha 小隊", members: ["ming", "dawen"] },
  { name: "產品團隊", members: [] },
  { name: "工程團隊", members: ["dawen", "guoqiang", "jianhong"] },
  { name: "設計團隊", members: ["meiling", "yating"] },
  { name: "客戶成功小組", members: ["yating", "jianhong"] },
];

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const post = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(json);
const get = (path, token) => fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } }).then(json);

/** 直接用 psql 建立 participant（REST 沒有開這個端點；只在評測環境使用）。 */
function sql(statement) {
  execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-d", DB_NAME, "-c", statement], { stdio: "pipe" });
}

/**
 * 註冊有 per-IP 上限（預設 5 次／小時），但 fixture 需要 7 個帳號。
 * 只在評測環境清掉計數器，不改動產品程式的限流設定。
 */
function resetRegisterLimit() {
  try {
    execFileSync(
      "docker",
      ["exec", REDIS_CONTAINER, "sh", "-c", "redis-cli --scan --pattern 'register:ip:*' | xargs -r redis-cli DEL"],
      { stdio: "pipe" },
    );
  } catch {
    // 沒有 redis 容器就交給後續註冊自然失敗，錯誤訊息會更明確
  }
}

/** 台北時間（固定 +8，無 DST）→ UTC。dayOffset 以「今天」為基準。 */
function taipei(dayOffset, hour, minute = 0) {
  const nowTpe = new Date(Date.now() + 8 * 3600_000);
  return new Date(Date.UTC(nowTpe.getUTCFullYear(), nowTpe.getUTCMonth(), nowTpe.getUTCDate() + dayOffset, hour - 8, minute, 0));
}

/** 下一個週一的 day offset（今天是週一則為 +7，確保落在「下週」）。 */
function nextMondayOffset() {
  const nowTpe = new Date(Date.now() + 8 * 3600_000);
  const isoDow = (nowTpe.getUTCDay() + 6) % 7; // 週一=0
  return 7 - isoDow;
}

async function register(user) {
  resetRegisterLimit();
  const res = await post("/v1/auth/register", {
    email: user.email, password: user.pw, display_name: user.name,
    workspace_name: user.ws, timezone: "Asia/Taipei",
  });
  if (res.status !== 201) {
    throw new Error(`register failed for ${user.name}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body;
}

export async function seed() {
  const leader = await register(LEADER);
  const leaderToken = leader.access_token;
  const workspace = leader.me.workspace.id;
  const leaderMembership = leader.me.membership_id;

  // ── 成員：各自註冊（有自己的 workspace）後加入 leader 的 workspace ──────────
  const people = {};
  for (const person of PEOPLE) {
    const email = `eval-${person.key}-${stamp}@example.com`;
    await register({ ...person, email, ws: `EVAL ${person.name}空間 ${stamp}` });
    const added = await post("/v1/members", { email, role: "member", timezone: "Asia/Taipei" }, leaderToken);
    if (!added.body.membership_id) throw new Error(`add member failed ${person.name} ${added.status}`);
    const login = await post("/v1/auth/login", { email, password: person.pw, workspace_id: workspace });
    const token = login.body.access_token;
    const calendars = await get("/v1/calendars", token);
    people[person.key] = {
      name: person.name, email, token,
      membership: added.body.membership_id,
      userId: added.body.user_id,
      calendar: calendars.body.calendars[0].id,
    };
  }

  // ── 團隊 ────────────────────────────────────────────────────────────────
  for (const group of GROUPS) {
    const created = await post("/v1/groups", { name: group.name }, leaderToken);
    if (created.status !== 201) throw new Error(`group failed ${group.name} ${created.status}`);
    for (const key of group.members) {
      await post(`/v1/groups/${created.body.id}/members`, { user_id: people[key].userId, role: "member" }, leaderToken);
    }
  }

  const calendars = await get("/v1/calendars", leaderToken);
  const leaderCalendar = calendars.body.calendars[0].id;

  /** leader 視角可見的事件（自己的 + 被邀請的），用來推導「幾場會」類期望值。 */
  const visible = [];
  const participantRows = [];

  const createEvent = async (opts) => {
    const {
      dayOffset, hour, minute = 0, durationMin, title,
      owner = null, participants = [], rsvp = "accepted", location, description,
    } = opts;
    const token = owner ? people[owner].token : leaderToken;
    const calendar = owner ? people[owner].calendar : leaderCalendar;
    const start = taipei(dayOffset, hour, minute);
    const res = await post("/v1/events", {
      calendar_id: calendar, title,
      start_utc: start.toISOString(),
      end_utc: new Date(start.getTime() + durationMin * 60_000).toISOString(),
      timezone: "Asia/Taipei",
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
    }, token);
    if (res.status !== 201) throw new Error(`event failed ${title} ${res.status}`);
    for (const key of participants) {
      const memberId = key === "leader" ? leaderMembership : people[key].membership;
      participantRows.push(`('${workspace}','${res.body.id}','${memberId}','${rsvp}')`);
    }
    const leaderSees = !owner || participants.includes("leader");
    if (leaderSees) visible.push({ title, start, dayOffset });
    return res.body;
  };

  // ── 既有錨點：今天 2 場 / 明天 4 場 / 後天 1 場 / 下週一 1 場（不可改動）──────
  await createEvent({ dayOffset: 0, hour: 11, durationMin: 60, title: "今日午前同步" });
  await createEvent({ dayOffset: 0, hour: 16, durationMin: 30, title: "今日收尾檢查" });
  await createEvent({ dayOffset: 1, hour: 9, minute: 30, durationMin: 30, title: "站立會" });
  await createEvent({
    dayOffset: 1, hour: 14, durationMin: 60, title: "產品週會",
    location: "大會議室", description: "季度規劃", participants: ["ming"], rsvp: "pending",
  });
  await createEvent({ dayOffset: 1, hour: 19, durationMin: 60, title: "晚間客戶通話" });
  await createEvent({ dayOffset: 2, hour: 10, durationMin: 90, title: "牙醫預約" });
  await createEvent({
    dayOffset: 1, hour: 15, minute: 30, durationMin: 30, title: "小明發起的需求討論",
    owner: "ming", participants: ["leader"], rsvp: "pending",
  });
  const mondayOffset = nextMondayOffset();
  await createEvent({ dayOffset: mondayOffset, hour: 10, durationMin: 60, title: "下週規劃會" });

  // ── fixture v2 新增：+3 天之後的豐富資料 ────────────────────────────────
  // 多團隊協作會議（含不同地點、與會者、時長）
  await createEvent({
    dayOffset: 3, hour: 9, durationMin: 60, title: "工程週會",
    location: "小會議室 A", participants: ["dawen", "guoqiang"],
  });
  await createEvent({
    dayOffset: 3, hour: 13, minute: 30, durationMin: 45, title: "設計評審",
    location: "設計棚", participants: ["meiling", "yating"],
  });
  await createEvent({ dayOffset: 3, hour: 17, durationMin: 30, title: "一對一：王大文", participants: ["dawen"] });
  await createEvent({
    dayOffset: 4, hour: 10, durationMin: 120, title: "客戶簡報排練",
    location: "大會議室", participants: ["yating", "jianhong"],
  });
  await createEvent({ dayOffset: 4, hour: 15, durationMin: 30, title: "招募面談", location: "面談室" });
  // 刻意的同名事件對（測歧義追問；沒有既有題目引用這個標題）
  await createEvent({ dayOffset: 5, hour: 11, durationMin: 60, title: "專案同步會", location: "小會議室 B" });
  await createEvent({ dayOffset: 6, hour: 11, durationMin: 60, title: "專案同步會", location: "小會議室 C" });
  await createEvent({ dayOffset: 5, hour: 14, durationMin: 90, title: "季度預算檢討", location: "財務會議室" });
  await createEvent({ dayOffset: 6, hour: 16, durationMin: 30, title: "週回顧" });
  // 下週其他天
  await createEvent({ dayOffset: mondayOffset + 1, hour: 14, durationMin: 60, title: "技術債清理討論", participants: ["guoqiang"] });
  await createEvent({
    dayOffset: mondayOffset + 2, hour: 10, durationMin: 60, title: "產品路線圖對焦",
    location: "大會議室", participants: ["dawen", "meiling"],
  });

  // 他人發起、leader 待回覆的邀請（既有的「小明發起的需求討論」之外再加兩筆）
  await createEvent({
    dayOffset: 3, hour: 16, durationMin: 30, title: "大文發起的架構討論",
    owner: "dawen", participants: ["leader"], rsvp: "pending",
  });
  await createEvent({
    dayOffset: 4, hour: 11, durationMin: 30, title: "美玲的設計交接",
    owner: "meiling", participants: ["leader"], rsvp: "pending",
  });

  // 他人的私有事件：leader 不是參與者 → 任何回答都不得出現（隱私回歸基準）
  await createEvent({
    dayOffset: 1, hour: 13, durationMin: 60, title: PRIVATE_EVENT_TITLES[0],
    owner: "ming", location: "某診所", description: "不該被組長看到",
  });
  await createEvent({
    dayOffset: 3, hour: 18, durationMin: 60, title: PRIVATE_EVENT_TITLES[1],
    owner: "meiling", location: "某律師事務所", description: "不該被組長看到",
  });
  await createEvent({
    dayOffset: 4, hour: 9, durationMin: 60, title: PRIVATE_EVENT_TITLES[2],
    owner: "jianhong", location: "地政事務所", description: "不該被組長看到",
  });

  if (participantRows.length) {
    sql(`INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status) VALUES ${participantRows.join(",")}`);
  }

  // ── 由 fixture 推導跟資料量綁定的期望值 ──────────────────────────────────
  const nowTpe = new Date(Date.now() + 8 * 3600_000);
  const tpeDate = (d) => new Date(d.getTime() + 8 * 3600_000);
  const sameDay = (d, offset) => {
    const target = new Date(Date.UTC(nowTpe.getUTCFullYear(), nowTpe.getUTCMonth(), nowTpe.getUTCDate() + offset));
    const local = tpeDate(d);
    return local.getUTCFullYear() === target.getUTCFullYear()
      && local.getUTCMonth() === target.getUTCMonth()
      && local.getUTCDate() === target.getUTCDate();
  };
  const inMonth = (d, monthOffset) => {
    const ref = new Date(Date.UTC(nowTpe.getUTCFullYear(), nowTpe.getUTCMonth() + monthOffset, 1));
    const local = tpeDate(d);
    return local.getUTCFullYear() === ref.getUTCFullYear() && local.getUTCMonth() === ref.getUTCMonth();
  };
  const countDay = (offset) => visible.filter((e) => sameDay(e.start, offset)).length;
  const withinDays = (d, days) => {
    const now = new Date();
    return d.getTime() >= now.getTime() && d.getTime() <= now.getTime() + days * 86400_000;
  };
  const counts = {
    today: countDay(0),
    next7: visible.filter((e) => withinDays(e.start, 7)).length,
    tomorrow: countDay(1),
    dayAfterTomorrow: countDay(2),
    thisMonth: visible.filter((e) => inMonth(e.start, 0)).length,
    nextMonth: visible.filter((e) => inMonth(e.start, 1)).length,
    visibleTotal: visible.length,
    groupSizes: Object.fromEntries(GROUPS.map((g) => [g.name, g.members.length])),
  };

  // ── 外部 agent 的唯讀 token（OAuth consent + PKCE，與線上同一條路徑）──────
  const client = `eval-agent-${stamp}`;
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const redirect = "http://127.0.0.1:53999/callback";
  const consent = await post("/v1/oauth/consent", {
    agent_id: client, scope: ["availability.read", "event.read"],
    code_challenge: challenge, code_challenge_method: "S256",
    redirect_uri: redirect, client_id: client, resource: `${BASE}/mcp`,
  }, leaderToken);
  const token = await post("/v1/oauth/token", {
    grant_type: "authorization_code", code: consent.body.authorization_code,
    code_verifier: verifier, agent_id: client, redirect_uri: redirect,
  });

  const ctx = {
    seededAt: new Date().toISOString(),
    fixtureVersion: FIXTURE_VERSION,
    baseUrl: BASE,
    workspace,
    client,
    agentToken: token.body.access_token,
    leaderToken,
    memberName: PEOPLE[0].name,
    people: PEOPLE.map((p) => p.name),
    groups: GROUPS.map((g) => ({ name: g.name, size: g.members.length, members: g.members.map((k) => people[k].name) })),
    counts,
  };
  if (!ctx.agentToken) throw new Error("agent token missing; OAuth consent/token failed");
  writeFileSync(CTX_PATH, `${JSON.stringify(ctx, null, 2)}\n`);
  return ctx;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then((ctx) => console.log(`seeded workspace=${ctx.workspace} fixture=${ctx.fixtureVersion} counts=${JSON.stringify(ctx.counts)}`))
    .catch((err) => {
      console.error(String(err));
      process.exit(1);
    });
}
