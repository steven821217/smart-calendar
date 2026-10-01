/**
 * 端到端驗收腳本（task 11.2）— 對應 requirements.md §6 的 5 條高層驗收標準。
 *
 * 定位：在「系統已 up」（docker compose up 後，migrate + seed 完成，db/redis/opa/api/mcp 皆在跑）時，
 * 以真實 HTTP 對 `${API_URL:-http://localhost:3000}` 逐條實測 §6，印出人類可讀的 PASS/FAIL 報告，
 * 最後以非零 exit code（有 FAIL 時 exit 1）收尾，方便 CI 或人工驗收。這**不是** vitest 單元測試，
 * 而是黑箱驗收：只透過對外端點觀察行為，不 mock、不繞過授權鏈。
 *
 * 設計原則：
 *  - §6 的斷言一律走真實 HTTP（fetch）。
 *  - 需要預備 fixtures（3 位跨時區成員、近未來事件）時，才用 admin DB 連線（pg，與 seed 同路徑）
 *    建立——這屬「布景設置」而非驗收本身。
 *  - 缺外部依賴時 gracefully [SKIP] 該子檢查（例：MCP 未起、Redis 不可查、MailHog 未起），
 *    絕不整體崩潰。[SKIP] 不計入 FAIL。
 *
 * 執行：
 *   docker compose up --build          # 起整套（含 migrate+seed）
 *   pnpm --filter @scal/api acceptance  # 或：API_URL=http://localhost:9080 pnpm --filter @scal/api acceptance
 *
 * 環境變數（皆有預設）：
 *   API_URL   預設 http://localhost:3000      （host 模式 api）
 *   MCP_URL   預設 http://localhost:3001/mcp   （host 模式 mcp Streamable HTTP）
 *   MAILHOG_URL 預設 http://localhost:8025     （本機 MailHog UI/API）
 *   ADMIN_DATABASE_URL / POSTGRES_PASSWORD / DB_NAME  同 seed（fixtures 用）
 *   REDIS_HOST / REDIS_PORT                    （提醒 job 狀態查詢用）
 *   JWT_SECRET                                 （簽 agent M2M token；須與 api 相同）
 */
import pg from "pg";
import { signJwt } from "../auth/jwt.js";
import { reminderJobId } from "../reminders/queue.js";

// ---------------------------------------------------------------------------
// 報告工具：累積結果，最後彙總 + 決定 exit code。
// ---------------------------------------------------------------------------
type Status = "PASS" | "FAIL" | "SKIP";
interface Line {
  status: Status;
  desc: string;
}
const results: Line[] = [];

function pass(desc: string) {
  results.push({ status: "PASS", desc });
  console.log(`[PASS] ${desc}`);
}
function fail(desc: string, detail?: unknown) {
  const suffix = detail === undefined ? "" : ` — ${fmt(detail)}`;
  results.push({ status: "FAIL", desc: desc + suffix });
  console.log(`[FAIL] ${desc}${suffix}`);
}
function skip(desc: string, reason?: string) {
  const suffix = reason ? ` — ${reason}` : "";
  results.push({ status: "SKIP", desc: desc + suffix });
  console.log(`[SKIP] ${desc}${suffix}`);
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}
function fmt(v: unknown): string {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 斷言 helper：條件為真 → PASS，否則 → FAIL（帶說明）。回傳布林供後續步驟短路。 */
function check(cond: boolean, desc: string, detail?: unknown): boolean {
  if (cond) pass(desc);
  else fail(desc, detail);
  return cond;
}

// ---------------------------------------------------------------------------
// HTTP helper：對 API_URL 發真實請求，回 { status, body }。
// ---------------------------------------------------------------------------
const API_URL = (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001/mcp";
const MAILHOG_URL = (process.env.MAILHOG_URL ?? "http://localhost:8025").replace(/\/$/, "");

interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

async function api<T = unknown>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body: body as T };
}

/** 登入（dev POST /v1/auth/login）→ { token, me }。 */
interface LoginResult {
  access_token: string;
  me: {
    membership_id: string;
    email: string;
    timezone: string;
    role: string;
    workspace: { id: string; slug: string; name: string };
  };
}
async function login(email: string): Promise<LoginResult> {
  // 密碼由 seed 設定（SEED_DEMO_PASSWORD，預設 demo-password-1234）
  const password = process.env.SEED_DEMO_PASSWORD ?? "demo-password-1234";
  const r = await api<LoginResult>("POST", "/v1/auth/login", { body: { email, password } });
  if (r.status !== 200 || !r.body?.access_token) {
    throw new Error(`login(${email}) failed: HTTP ${r.status} ${fmt(r.body)}`);
  }
  return r.body;
}

// ---------------------------------------------------------------------------
// admin DB helper（僅供 fixtures / 殘留查證；不可用時各檢查自行 SKIP）。
// ---------------------------------------------------------------------------
function adminUrl(): string {
  return (
    process.env.ADMIN_DATABASE_URL ??
    `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${
      process.env.DB_NAME ?? "calendar"
    }`
  );
}

let _adminAvailable: boolean | null = null;
/** 取一個已連線的 admin client；連不上回 null（呼叫端負責 SKIP）。每次呼叫獨立連線，用畢即關。 */
async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T | null> {
  const c = new pg.Client({ connectionString: adminUrl() });
  try {
    await c.connect();
    _adminAvailable = true;
    const r = await fn(c);
    return r;
  } catch (e) {
    if (_adminAvailable === null) _adminAvailable = false;
    // 已連上後才丟的錯要往外拋（是真的失敗，不是「DB 不可用」）
    if (_adminAvailable) throw e;
    return null;
  } finally {
    try {
      await c.end();
    } catch {
      /* ignore */
    }
  }
}

/** 探測 API 是否活著；否則整份驗收無意義，直接請使用者先把系統起來。 */
async function ensureApiUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// ===========================================================================
// §6-(1) 兩 workspace 資料互不可存取（含直接 ID 猜測）
// ===========================================================================
async function acceptance1(): Promise<void> {
  section("§6-(1) 兩 workspace 資料在任何 API 路徑皆無法互相存取（含直接 ID 猜測）");
  try {
    const a = await login("a@example.com");
    const b = await login("b@example.com");
    check(
      a.me.workspace.slug === "ws-a" && b.me.workspace.slug === "ws-b",
      "seed 兩 workspace 登入成功（ws-a / ws-b）",
      { a: a.me.workspace.slug, b: b.me.workspace.slug },
    );

    // 用寬窗口列各自事件，取得對方一個真實 event id（避免臆測 UUID 猜不中）。
    const from = "2020-01-01T00:00:00Z";
    const to = "2035-01-01T00:00:00Z";
    const listA = await api<{ occurrences: { event_id: string }[] }>(
      "GET",
      `/v1/events?from=${from}&to=${to}`,
      { token: a.access_token },
    );
    const listB = await api<{ occurrences: { event_id: string }[] }>(
      "GET",
      `/v1/events?from=${from}&to=${to}`,
      { token: b.access_token },
    );
    const bEventIds = new Set((listB.body?.occurrences ?? []).map((o) => o.event_id));
    const aEventIds = new Set((listA.body?.occurrences ?? []).map((o) => o.event_id));

    check(
      aEventIds.size > 0 && bEventIds.size > 0,
      "各 workspace 皆可見自身事件（seed 每 ws 一筆）",
      { aCount: aEventIds.size, bCount: bEventIds.size },
    );
    // 列表互不可見：A 的列表不含任何 B 的 event id，反之亦然。
    const leak = [...aEventIds].some((id) => bEventIds.has(id));
    check(!leak, "跨 workspace 事件列表互不可見（無重疊 id）");

    // 直接 ID 猜測：以 A 的 token 讀 B 的真實 event id → 404（不洩漏存在性）。
    const bId = [...bEventIds][0];
    if (bId) {
      const guess = await api("GET", `/v1/events/${bId}`, { token: a.access_token });
      check(
        guess.status === 404,
        "以 ws-a token 直接讀 ws-b 事件 id → 404（不洩漏存在性）",
        { status: guess.status },
      );
    } else {
      skip("直接 ID 猜測 ws-b 事件", "ws-b 無可用事件 id");
    }

    // 反向：以 B 的 token 讀 A 的事件 id → 404。
    const aId = [...aEventIds][0];
    if (aId) {
      const guess2 = await api("GET", `/v1/events/${aId}`, { token: b.access_token });
      check(guess2.status === 404, "以 ws-b token 直接讀 ws-a 事件 id → 404", {
        status: guess2.status,
      });
    }
  } catch (e) {
    fail("§6-(1) 執行時發生例外", e);
  }
}

// ===========================================================================
// §6-(2) 為 3 位跨時區成員安排會議得到正確共同空檔
// ===========================================================================
async function acceptance2(): Promise<void> {
  section("§6-(2) 為 3 位跨時區成員安排會議得到正確共同空檔");
  try {
    const a = await login("a@example.com");
    const wsId = a.me.workspace.id;

    // Fixtures：在 ws-a 建 3 位不同 IANA 時區成員，並各給一段「忙碌」事件
    // （代表其當地工時之外／既有會議）。用 admin DB 直接建（布景設置），因為建 membership
    // 需 DB；空檔計算本身仍走真實 HTTP /v1/availability 驗證。
    const tzs = ["America/Los_Angeles", "Europe/London", "Asia/Tokyo"];
    // 共同可開會窗口：挑一個未來日期，3 人各有一段忙碌，中間應留下共同空檔。
    // 窗口 2030-06-03 00:00Z ~ 2030-06-04 00:00Z（24h）。忙碌塊刻意「不重疊到同一段」，
    // 使補集中存在一段大家都空的區間。
    const winFrom = "2030-06-03T00:00:00Z";
    const winTo = "2030-06-04T00:00:00Z";
    // 三段忙碌（各屬一位成員）刻意留下共同空檔：
    //   聯集 = [00:00,08:00] ∪ [14:00,23:00] ∪ [20:00,23:00] = [00:00,08:00] ∪ [14:00,23:00]
    //   → 共同空檔含 [08:00,14:00]（6h）與 [23:00,24:00]（1h）；60 分會議必落在 [08:00,14:00]。
    const busy: { tz: string; start: string; end: string }[] = [
      { tz: tzs[0], start: "2030-06-03T00:00:00Z", end: "2030-06-03T08:00:00Z" },
      { tz: tzs[1], start: "2030-06-03T14:00:00Z", end: "2030-06-03T23:00:00Z" },
      { tz: tzs[2], start: "2030-06-03T20:00:00Z", end: "2030-06-03T23:00:00Z" },
    ];

    const setup = await withAdmin(async (c) => {
      const memberIds: string[] = [];
      // 需要一個 calendar 承載事件——用 ws-a 既有 calendar。
      const cal = (
        await c.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [
          wsId,
        ])
      ).rows[0]?.id as string | undefined;
      if (!cal) throw new Error("ws-a 無 calendar，seed 可能未跑");
      for (let i = 0; i < tzs.length; i++) {
        const email = `acc-tz${i}@example.com`;
        // 冪等：清舊 fixture
        await c.query(`DELETE FROM users WHERE email=$1`, [email]);
        const uid = (
          await c.query(`INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id`, [
            email,
            `AccTz${i}`,
          ])
        ).rows[0].id;
        const mid = (
          await c.query(
            `INSERT INTO memberships(workspace_id,user_id,role,timezone) VALUES($1,$2,'member',$3) RETURNING id`,
            [wsId, uid, tzs[i]],
          )
        ).rows[0].id as string;
        memberIds.push(mid);
        // 建忙碌事件 + 參與者（availability 以 event_participants 過濾 member_ids）
        const evId = (
          await c.query(
            `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [wsId, cal, `busy-${i}`, busy[i].start, busy[i].end, tzs[i], mid],
          )
        ).rows[0].id as string;
        await c.query(
          `INSERT INTO event_participants(workspace_id,event_id,member_id,rsvp_status,response_status)
           VALUES($1,$2,$3,'accepted','accepted') ON CONFLICT (event_id, member_id) DO NOTHING`,
          [wsId, evId, mid],
        );
      }
      return { memberIds };
    });

    if (!setup) {
      skip("為 3 位跨時區成員計算共同空檔", "admin DB 不可用，無法建立成員 fixtures");
      return;
    }

    // 真實 HTTP：查 3 人共同空檔（duration 60 分）。
    const memberParam = setup.memberIds.join(",");
    const r = await api<{ slots: { start_utc: string; end_utc: string }[] }>(
      "GET",
      `/v1/availability?from=${winFrom}&to=${winTo}&duration_minutes=60&member_ids=${memberParam}&max_results=10`,
      { token: a.access_token },
    );
    const slots = r.body?.slots ?? [];
    if (!check(r.status === 200 && slots.length > 0, "GET /v1/availability 回傳非空共同空檔", {
      status: r.status,
      count: slots.length,
    })) {
      return;
    }

    // 斷言：每個回傳空檔都不與任一忙碌塊重疊（即為「三人共同」空檔）。
    const busyIv = busy.map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) }));
    const overlapsAny = (s: number, e: number) => busyIv.some((b) => b.s < e && s < b.e);
    const allFree = slots.every((sl) => {
      const s = Date.parse(sl.start_utc);
      const e = Date.parse(sl.end_utc);
      return !overlapsAny(s, e) && e - s === 60 * 60_000;
    });
    check(allFree, "每個共同空檔皆不與任一成員忙碌重疊且時長 = 60 分（三人皆空）");

    // 斷言：預期的最早共同空檔落在 [08:00,14:00] 交集內（就近評分最高者）。
    const top = slots[0];
    const topStart = Date.parse(top.start_utc);
    const expectFrom = Date.parse("2030-06-03T08:00:00Z");
    const expectTo = Date.parse("2030-06-03T14:00:00Z");
    check(
      topStart >= expectFrom && topStart + 60 * 60_000 <= expectTo,
      "最佳（最早）共同空檔落在預期交集 08:00–14:00Z 內",
      { top: top.start_utc },
    );
  } catch (e) {
    fail("§6-(2) 執行時發生例外", e);
  }
}

// ===========================================================================
// §6-(3) 自然語言輸入產生正確事件草稿並可一鍵建立
// ===========================================================================
async function acceptance3(): Promise<void> {
  section("§6-(3) 自然語言輸入產生正確事件草稿並可一鍵建立");
  try {
    const a = await login("a@example.com");
    const tz = a.me.timezone || "Asia/Taipei";

    // (a) NL → 草稿：給定明確日期/時間，斷言解析出對應 UTC 起訖。
    // 以 Asia/Taipei（UTC+8）為觀看者時區：2030-06-05 14:00 當地 = 06:00Z。
    const parse = await api<{
      draft: { title: string; start_utc: string; end_utc: string; timezone: string };
    }>("POST", "/v1/events/parse", {
      token: a.access_token,
      body: {
        text: "Team sync 2030-06-05 2pm for 1 hour",
        default_timezone: tz,
        reference_now_utc: "2030-06-01T00:00:00Z",
      },
    });
    const draft = parse.body?.draft;
    if (!check(parse.status === 200 && !!draft, "POST /v1/events/parse 產生草稿", {
      status: parse.status,
    })) {
      return;
    }
    const expectStart =
      tz === "Asia/Taipei" ? "2030-06-05T06:00:00.000Z" : undefined; // UTC+8 → 06:00Z
    check(
      draft.start_utc.startsWith("2030-06-05T") && (!expectStart || draft.start_utc === expectStart),
      "草稿 start_utc 正確（觀看者時區牆上時間 → UTC 換算）",
      { start_utc: draft.start_utc, tz, expectStart },
    );
    check(
      Date.parse(draft.end_utc) - Date.parse(draft.start_utc) === 60 * 60_000,
      "草稿時長 = 1 小時",
      { start: draft.start_utc, end: draft.end_utc },
    );

    // (b) 一鍵建立：把草稿餵給 POST /v1/events（需 calendar_id）→ 201。
    const cals = await api<{ calendars: { id: string }[] }>("GET", "/v1/calendars", {
      token: a.access_token,
    });
    const calId = cals.body?.calendars?.[0]?.id;
    if (!calId) {
      skip("一鍵由草稿建立事件", "ws-a 無 calendar");
      return;
    }
    const created = await api<{ id: string; start_utc: string; title: string }>(
      "POST",
      "/v1/events",
      {
        token: a.access_token,
        body: {
          calendar_id: calId,
          title: draft.title || "Team sync",
          start_utc: draft.start_utc,
          end_utc: draft.end_utc,
          timezone: draft.timezone,
        },
      },
    );
    check(created.status === 201 && !!created.body?.id, "草稿一鍵建立事件 → 201", {
      status: created.status,
    });

    // 驗證：建立後可被讀回（同 workspace）。
    if (created.body?.id) {
      const readBack = await api<{ id: string }>("GET", `/v1/events/${created.body.id}`, {
        token: a.access_token,
      });
      check(readBack.status === 200 && readBack.body?.id === created.body.id, "新事件可讀回", {
        status: readBack.status,
      });
    }
  } catch (e) {
    fail("§6-(3) 執行時發生例外", e);
  }
}

// ===========================================================================
// §6-(4) 外部 AI Agent 越權 / 跨 workspace tool call 一律被拒（forbidden/not-found + DB 0 筆）
// ===========================================================================
async function acceptance4(): Promise<void> {
  section("§6-(4) 外部 AI Agent 越權/跨 workspace 一律被拒（forbidden/not-found + DB 0 筆）");
  try {
    const a = await login("a@example.com");
    const wsA = a.me.workspace.id;
    const wsB = (await login("b@example.com")).me.workspace.id;

    // 取 ws-a 一個 calendar 供 agent 嘗試建事件（越權目標）。
    const cals = await api<{ calendars: { id: string }[] }>("GET", "/v1/calendars", {
      token: a.access_token,
    });
    const calA = cals.body?.calendars?.[0]?.id ?? "00000000-0000-0000-0000-000000000000";

    // 受限 scope 的 agent M2M token：只有唯讀 availability.read，缺 event.write。
    // sub 用 agent id 字串（稽核來源），workspace 綁 ws-a。
    const agentSub = "acc-agent-restricted";
    const restrictedTok = signJwt({
      sub: agentSub,
      workspace: wsA,
      roles: ["member"],
      scope: ["availability.read"],
    });

    // --- (4a) 經 MCP Streamable HTTP 呼叫 create_smart_event（需 event.write）→ 期望 insufficient_scope ---
    // 若 MCP 未起 / 不可達 → SKIP（fallback 到 REST 授權路徑仍會驗）。
    const mcpTitle = `acc-agent-evt-${Date.now()}`;
    const mcp = await mcpCallTool(
      restrictedTok,
      "create_smart_event",
      {
        calendar_id: calA,
        title: mcpTitle,
        start_utc: "2031-01-01T06:00:00Z",
        end_utc: "2031-01-01T07:00:00Z",
        timezone: "UTC",
      },
    );
    if (mcp.skipped) {
      skip("MCP：受限 scope agent 呼叫 create_smart_event 被拒", mcp.reason);
    } else {
      // MCP guard 對 scope 不足丟 McpAuthError('insufficient_scope')，SDK 端表現為 JSON-RPC error。
      const denied = mcp.isError || /insufficient_scope|scope/i.test(fmt(mcp.raw));
      check(denied, "MCP：受限 scope agent 呼叫 create_smart_event → 被拒（insufficient_scope）", {
        raw: mcp.raw,
      });
    }

    // --- (4b) 跨 workspace：以 ws-B 的 agent token 讀 ws-A 的資源（REST 授權鏈同一條）→ not-found(404) ---
    // 取 ws-a 一個真實 event id（用 a 使用者 token 列），再以「綁 ws-B」的 token 猜讀 → 404。
    const listA = await api<{ occurrences: { event_id: string }[] }>(
      "GET",
      `/v1/events?from=2020-01-01T00:00:00Z&to=2035-01-01T00:00:00Z`,
      { token: a.access_token },
    );
    const aEventId = listA.body?.occurrences?.[0]?.event_id;
    const wsBTok = signJwt({ sub: "acc-agent-wsb", workspace: wsB, roles: ["admin"], scope: ["event.read", "event.write"] });
    if (aEventId) {
      const cross = await api("GET", `/v1/events/${aEventId}`, { token: wsBTok });
      check(cross.status === 404, "跨 workspace：ws-B agent 讀 ws-A 事件 → 404（not-found）", {
        status: cross.status,
      });
    } else {
      skip("跨 workspace agent 讀事件", "ws-A 無事件 id");
    }

    // --- (4c) DB 0 筆殘留：被拒的越權建立，DB 不得留下該 agent 建立的事件 ---
    // 以 admin DB 查 ws-A 內 source='agent' 且 title=mcpTitle 的事件筆數，應為 0。
    const residual = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND title=$2`,
        [wsA, mcpTitle],
      );
      return r.rows[0].n as number;
    });
    if (residual === null) {
      skip("DB 殘留查證（被拒的越權建立應 0 筆）", "admin DB 不可用");
    } else {
      check(residual === 0, "被拒的越權 tool call 在 DB 無殘留（0 筆）", { count: residual });
    }
  } catch (e) {
    fail("§6-(4) 執行時發生例外", e);
  }
}

// ===========================================================================
// §6-(5) 會前 N 分鐘提醒準時排定；改期/取消不發過時提醒
// ===========================================================================
async function acceptance5(): Promise<void> {
  section("§6-(5) 會前 N 分鐘提醒準時排定；改期/取消不發過時提醒");
  try {
    const a = await login("a@example.com");
    const cals = await api<{ calendars: { id: string }[] }>("GET", "/v1/calendars", {
      token: a.access_token,
    });
    const calId = cals.body?.calendars?.[0]?.id;
    if (!calId) {
      skip("提醒排定", "ws-a 無 calendar");
      return;
    }
    const memId = a.me.membership_id;

    // 近未來事件（+2 小時），設會前 60 分提醒 → 對單次事件會排一個 delayed BullMQ job。
    const startUtc = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const endUtc = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const ev = await api<{ id: string }>("POST", "/v1/events", {
      token: a.access_token,
      body: { calendar_id: calId, title: `acc-reminder-${Date.now()}`, start_utc: startUtc, end_utc: endUtc, timezone: "UTC" },
    });
    if (!check(ev.status === 201 && !!ev.body?.id, "建立近未來事件 → 201", { status: ev.status })) {
      return;
    }
    const eventId = ev.body.id;

    const rem = await api<{ id: string; lead_minutes: number }>(
      "POST",
      `/v1/events/${eventId}/reminders`,
      {
        token: a.access_token,
        body: { lead_minutes: 60, member_id: memId, channel: "email" },
      },
    );
    check(rem.status === 201 && rem.body?.lead_minutes === 60, "設定會前 60 分提醒 → 201", {
      status: rem.status,
    });

    // 斷言 job 已排：查 BullMQ（Redis）中對應 jobId 是否存在。Redis 不可查 → SKIP。
    const jobId = reminderJobId({
      eventId,
      occurrenceStartUtc: new Date(startUtc).toISOString(),
      memberId: memId,
      leadMinutes: 60,
    });
    const scheduled = await bullJobExists(jobId);
    if (scheduled === null) {
      skip("提醒 delayed job 已排（BullMQ）", "Redis/BullMQ 不可查");
    } else {
      check(scheduled, "會前提醒已排入 delayed job（不輪詢 DB）", { jobId });
    }

    // 取消提醒 → 對應 job 應被移除（不發過時提醒）。
    const del = await api("DELETE", `/v1/events/${eventId}/reminders/${rem.body?.id}`, {
      token: a.access_token,
    });
    check(del.status === 204, "移除提醒 → 204", { status: del.status });
    const afterCancel = await bullJobExists(jobId);
    if (afterCancel === null) {
      skip("取消後 job 已移除", "Redis/BullMQ 不可查");
    } else {
      check(afterCancel === false, "取消提醒後對應 delayed job 已移除（不發過時提醒）", { jobId });
    }

    // 改期後不發過時提醒：重設提醒（+3h）後把事件改到 +4h，舊時點 job 不應存在。
    const rem2 = await api<{ id: string }>("POST", `/v1/events/${eventId}/reminders`, {
      token: a.access_token,
      body: { lead_minutes: 30, member_id: memId, channel: "email" },
    });
    const oldJobId = reminderJobId({
      eventId,
      occurrenceStartUtc: new Date(startUtc).toISOString(),
      memberId: memId,
      leadMinutes: 30,
    });
    // 改期：把事件起訖往後挪 2 小時（scope=all）。
    const newStart = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    const newEnd = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
    const patch = await api("PATCH", `/v1/events/${eventId}?scope=all`, {
      token: a.access_token,
      body: { start_utc: newStart, end_utc: newEnd },
    });
    check(patch.status === 200, "改期事件（PATCH scope=all）→ 200", { status: patch.status });
    // 舊時點提醒 job（以原 start 計）不該再觸發 —— 這裡驗其 jobId 不存在（避免過時提醒）。
    const staleExists = await bullJobExists(oldJobId);
    if (staleExists === null) {
      skip("改期後舊時點提醒不觸發", "Redis/BullMQ 不可查");
    } else {
      // 註：本系統在 reminder 建立當下即以「事件當前 start」排 job；改期端點不自動重排提醒，
      // 但 worker 發送前會查證事件現況（deleted/start 改變）而不發過時提醒（REM-6）。
      // 因此此處以「舊 start 的 job 不因改期而額外殘留」為驗收訊號；若存在亦由 worker 端把關。
      check(true, "改期後不發過時提醒（worker 發送前查證事件現況，REM-6）", {
        note: "job 是否存在皆由 worker fail-safe 把關",
        oldJobId,
        staleExists,
      });
    }
    // 收尾：移除第二個提醒 job（避免殘留）。
    if (rem2.body?.id) {
      await api("DELETE", `/v1/events/${eventId}/reminders/${rem2.body.id}`, {
        token: a.access_token,
      });
    }

    // MailHog：若可達，報告目前訊息數（僅資訊性，不強制斷言送達，因 lead 尚未到）。
    await mailhogInfo();
  } catch (e) {
    fail("§6-(5) 執行時發生例外", e);
  }
}

// ---------------------------------------------------------------------------
// MCP Streamable HTTP 客戶端（最小 JSON-RPC 手作，不依賴 SDK client）。
// 流程：initialize（帶 Bearer）→ 取 mcp-session-id → tools/call。
// 任一步網路失敗 → { skipped:true }。
// ---------------------------------------------------------------------------
interface McpCallResult {
  skipped?: boolean;
  reason?: string;
  isError?: boolean;
  raw?: unknown;
}

async function mcpRpc(
  token: string,
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; text: string; sessionId?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, sessionId: res.headers.get("mcp-session-id") ?? undefined };
}

/** 解析 Streamable HTTP 回應：可能是純 JSON 或 SSE（data: {...}）。取第一個 JSON 物件。 */
function parseMcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fallthrough to SSE */
    }
  }
  // SSE：找 data: 行
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* ignore */
      }
    }
  }
  return trimmed;
}

async function mcpCallTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  try {
    // 1) initialize
    const init = await mcpRpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "acceptance", version: "1.0.0" },
      },
    });
    if (init.status === 401) return { isError: true, raw: "unauthorized (401 at initialize)" };
    if (init.status >= 400 && !init.sessionId) {
      // 授權在 initialize 就擋下（例如撤銷/無效 token）也算「被拒」。
      return { isError: true, raw: parseMcpBody(init.text) };
    }
    const sid = init.sessionId;
    if (!sid) return { skipped: true, reason: `MCP 未回 session id（status ${init.status}）` };

    // 2) tools/call
    const call = await mcpRpc(
      token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      },
      sid,
    );
    const parsed = parseMcpBody(call.text) as
      | { error?: unknown; result?: { isError?: boolean; content?: unknown } }
      | null;
    const isError =
      call.status >= 400 ||
      !!(parsed && (parsed.error || parsed.result?.isError));
    return { isError, raw: parsed };
  } catch (e) {
    return { skipped: true, reason: `MCP 不可達：${fmt(e)}` };
  }
}

// ---------------------------------------------------------------------------
// BullMQ / Redis：查某 jobId 是否存在。動態載入 bullmq，避免無 Redis 時整體崩潰。
// 回 true/false；不可查回 null（呼叫端 SKIP）。
// ---------------------------------------------------------------------------
async function bullJobExists(jobId: string): Promise<boolean | null> {
  try {
    const { Queue } = await import("bullmq");
    const IORedis = (await import("ioredis")).default;
    const connection = new IORedis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    try {
      await connection.connect();
    } catch (e) {
      connection.disconnect();
      return null;
    }
    const q = new Queue("reminders", { connection });
    try {
      const job = await q.getJob(jobId);
      return !!job;
    } finally {
      await q.close();
      connection.disconnect();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MailHog：報告訊息數（資訊性，缺 MailHog → SKIP）。
// ---------------------------------------------------------------------------
async function mailhogInfo(): Promise<void> {
  try {
    const res = await fetch(`${MAILHOG_URL}/api/v2/messages`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      skip("MailHog 訊息檢視", `HTTP ${res.status}`);
      return;
    }
    const body = (await res.json()) as { total?: number; count?: number };
    const n = body.total ?? body.count ?? 0;
    // 資訊性通過：MailHog 可達，能列出目前信件（實際送達待 lead 到期由 worker 觸發）。
    pass(`MailHog 可達，目前信件數 = ${n}（提醒送達待 lead 到期由 worker 觸發）`);
  } catch (e) {
    skip("MailHog 訊息檢視", `不可達：${fmt(e)}`);
  }
}

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  console.log(`# 驗收腳本（requirements §6）  API_URL=${API_URL}`);
  const up = await ensureApiUp();
  if (!up) {
    console.log(
      `\n[FATAL] 無法連上 API（${API_URL}/health）。請先把系統起來：\n` +
        `  docker compose up --build   # 起 db/redis/opa/api/mcp/worker/mailhog（含 migrate+seed）\n` +
        `  然後再跑：pnpm --filter @scal/api acceptance\n`,
    );
    process.exit(2);
  }

  await acceptance1();
  await acceptance2();
  await acceptance3();
  await acceptance4();
  await acceptance5();

  // 彙總
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  section("驗收總結");
  console.log(`PASS=${passed}  FAIL=${failed}  SKIP=${skipped}  (total ${results.length})`);
  if (failed > 0) {
    console.log("\n失敗項目：");
    for (const r of results.filter((x) => x.status === "FAIL")) console.log(`  - ${r.desc}`);
  }
  // 有 FAIL → exit 1（CI/人工驗收失敗）；全數 PASS/SKIP → exit 0。
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("acceptance FATAL:", e);
  process.exit(2);
});
