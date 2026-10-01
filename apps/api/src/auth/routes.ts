import type { FastifyInstance } from "fastify";
import pg from "pg";
import Redis from "ioredis";
import { CreateWorkspaceInput, RegisterInput } from "@scal/shared";
import { signJwt, USER_ACCESS_TOKEN_TTL_SEC } from "./jwt.js";
import { hashPassword, verifyPassword, PASSWORD_MAX } from "./password.js";

/**
 * 認證端點（api.md 1/4）。
 *
 * 登入採 email + 密碼（scrypt 雜湊，見 password.ts）：
 *  - 帳號不存在、未設密碼、密碼錯誤 → 一律回相同的 401（不洩漏帳號是否存在）。
 *  - 連續失敗會被暫時鎖住（Redis 計數），降低暴力破解可行性。
 *  - workspace 脈絡只放進 token（ISO-3），前端永遠不能自行指定 workspace。
 *
 * ⚠️ 仍待補（tasks.md 3.2）：refresh token 輪替、RS256/JWKS、註冊與改密碼流程。
 */

// 直接用 admin 連線查 identity（登入前尚無 workspace 脈絡，故不走 app_user/RLS）。
const adminUrl =
  process.env.ADMIN_DATABASE_URL ??
  `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${
    process.env.DB_NAME ?? "calendar"
  }`;

let _client: pg.Pool | null = null;
function adminPool() {
  if (!_client) _client = new pg.Pool({ connectionString: adminUrl });
  return _client;
}

/** 登入失敗節流：同一 email 在視窗內失敗達上限即暫時拒絕（不透露是哪一種失敗）。 */
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS ?? 8);
/** 一個帳號最多可擁有的 workspace 數（資源耗盡防護；被邀請加入的不計入建立行為）。 */
const WORKSPACE_MAX_PER_USER = Number(process.env.WORKSPACE_MAX_PER_USER ?? 10);
const LOGIN_FAIL_WINDOW_SEC = Number(process.env.LOGIN_FAIL_WINDOW_SEC ?? 900);

let _redis: Redis | null = null;
function redis(): Redis | null {
  // Redis 不可用時不阻斷登入（節流是加值防護，不是認證本身）
  if (process.env.LOGIN_THROTTLE === "0") return null;
  if (!_redis) {
    _redis = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    _redis.on("error", () => {
      /* 靜默：節流失效不應讓登入整體壞掉 */
    });
  }
  return _redis;
}

const failKey = (email: string) => `login:fail:${email}`;

/** 自助註冊開關：封閉部署可設 REGISTRATION_ENABLED=0 關閉。 */
const REGISTRATION_ENABLED = process.env.REGISTRATION_ENABLED !== "0";
/** 同一來源 IP 的註冊上限（每個視窗）——每次註冊都會建立一個新 workspace，需防濫用。 */
const REGISTER_MAX_PER_IP = Number(process.env.REGISTER_MAX_PER_IP ?? 5);
const REGISTER_WINDOW_SEC = Number(process.env.REGISTER_WINDOW_SEC ?? 3600);
const regKey = (ip: string) => `register:ip:${ip}`;

async function tooManyRegistrations(ip: string): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  try {
    return Number((await r.get(regKey(ip))) ?? 0) >= REGISTER_MAX_PER_IP;
  } catch {
    return false;
  }
}

async function noteRegistration(ip: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    const n = await r.incr(regKey(ip));
    if (n === 1) await r.expire(regKey(ip), REGISTER_WINDOW_SEC);
  } catch {
    /* 忽略 */
  }
}

/**
 * workspace_name → slug（citext UNIQUE）。中文等非 ASCII 會被移除，故可能得到空字串，
 * 一律補上隨機尾碼確保可用且不可預測；attempt>0 時換新尾碼重試（撞名時）。
 */
function slugify(name: string, attempt: number): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 8);
  void attempt; // 每次都用新隨機尾碼，attempt 僅控制重試次數
  return base ? `${base}-${suffix}` : `ws-${suffix}`;
}

/** 只接受 Intl 認得的 IANA 時區，否則回 null（呼叫端退回 UTC）。 */
function validTimezone(tz?: string): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

interface MembershipRow {
  membership_id: string;
  role: string;
  timezone: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  display_name: string;
  email: string;
}

/**
 * 由「某個 membership id」反查同一個人的所有 membership（工作區清單／切換用）。
 * token 的 sub 是 membership id，故先由它找到 user，再列出該 user 的全部 membership。
 */
async function memberships(membershipId: string): Promise<MembershipRow[] | null> {
  if (!UUID_RE.test(membershipId)) return null;
  const r = await adminPool().query(
    `SELECT m.id AS membership_id, m.role, m.timezone, m.workspace_id,
            w.slug AS workspace_slug, w.name AS workspace_name,
            u.display_name, u.email
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       JOIN users u ON u.id = m.user_id
      WHERE m.status = 'active'
        AND u.id = (SELECT user_id FROM memberships WHERE id = $1)
      ORDER BY m.created_at`,
    [membershipId],
  );
  return r.rows.length ? (r.rows as MembershipRow[]) : null;
}

async function tooManyFailures(email: string): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  try {
    const n = Number((await r.get(failKey(email))) ?? 0);
    return n >= LOGIN_MAX_FAILS;
  } catch {
    return false;
  }
}

async function noteFailure(email: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    const key = failKey(email);
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, LOGIN_FAIL_WINDOW_SEC);
  } catch {
    /* 忽略 */
  }
}

async function clearFailures(email: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.del(failKey(email));
  } catch {
    /* 忽略 */
  }
}

export function registerAuthRoutes(app: FastifyInstance) {
  // 1. POST /v1/auth/login — email + password → membership → 簽 access token
  //    一個人可能屬於多個 workspace（自己註冊一個 + 被 leader 加入另一個）。
  //    此時不能隨便挑一個（舊實作 LIMIT 1 無 ORDER BY，會隨機進錯工作區）：
  //      - 恰好 1 個 → 直接發 token（原行為）。
  //      - 多於 1 個且未指定 workspace_id → 回 200 + { needs_workspace_selection, workspaces }，**不發 token**。
  //      - 指定了 workspace_id → 驗證他真的有該 membership，才發該 workspace 的 token。
  //    workspace 仍只能由伺服器簽進 token（ISO-3），前端無法自行變更。
  app.post<{ Body: { email?: string; password?: string; workspace_id?: string } }>(
    "/v1/auth/login",
    async (req, reply) => {
      const email = req.body?.email?.trim().toLowerCase();
      const password = req.body?.password;
      const wantedWorkspace = req.body?.workspace_id;
      if (!email || !password) {
        return reply
          .code(422)
          .send({ type: "…/validation", title: "email and password required", status: 422 });
      }
      // 過長輸入直接拒絕：不讓 KDF 為無意義的輸入做工（DoS 面）
      if (password.length > PASSWORD_MAX) {
        return reply
          .code(422)
          .send({ type: "…/validation", title: "password too long", status: 422 });
      }

      // 通用失敗回應：不區分「帳號不存在 / 未設密碼 / 密碼錯」
      const unauthorized = () =>
        reply.code(401).send({ type: "…/unauthorized", title: "invalid credentials", status: 401 });

      if (await tooManyFailures(email)) {
        return reply.code(429).send({
          type: "…/too-many-requests",
          title: "too many failed attempts",
          status: 429,
          detail: "登入失敗次數過多，請稍後再試。",
        });
      }

      const r = await adminPool().query(
        `SELECT m.id AS membership_id, m.role, m.timezone, m.workspace_id,
                w.slug AS workspace_slug, w.name AS workspace_name,
                u.display_name, u.email, u.password_hash
           FROM users u
           JOIN memberships m ON m.user_id = u.id
           JOIN workspaces w ON w.id = m.workspace_id
          WHERE u.email = $1 AND m.status = 'active'
          ORDER BY m.created_at`,
        [email],
      );
      const rows = r.rows;
      // 帳號不存在也要付出一次雜湊驗證的時間，避免以回應時間探測帳號是否存在
      const ok = await verifyPassword(password, rows[0]?.password_hash ?? null);
      if (rows.length === 0 || !ok) {
        await noteFailure(email);
        return unauthorized();
      }
      await clearFailures(email);

      let row = rows[0];
      if (wantedWorkspace) {
        const picked = rows.find((x) => x.workspace_id === wantedWorkspace);
        if (!picked) return unauthorized(); // 沒有該 workspace 的 membership
        row = picked;
      } else if (rows.length > 1) {
        // 讓使用者選；此回應不含 token
        return {
          needs_workspace_selection: true as const,
          workspaces: rows.map((x) => ({
            id: x.workspace_id,
            slug: x.workspace_slug,
            name: x.workspace_name,
            role: x.role,
          })),
        };
      }

      // sub = membership id（events.created_by 對映 membership，見 seed）
      const token = signJwt({
        sub: row.membership_id,
        workspace: row.workspace_id,
        roles: [row.role],
      });
      return {
        access_token: token,
        token_type: "Bearer",
        expires_in: USER_ACCESS_TOKEN_TTL_SEC,
        me: meFromRow(row),
      };
    },
  );

  // 1b. GET /v1/auth/workspaces — 我（已登入）所屬的所有 workspace（供切換器）
  app.get("/v1/auth/workspaces", async (req, reply) => {
    const { verifyJwt } = await import("./jwt.js");
    const auth = verifyJwt(req.headers.authorization);
    if (!auth) return reply.code(401).send({ type: "…/unauthorized", title: "unauthorized", status: 401 });
    const rows = await memberships(auth.sub);
    if (!rows) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    return {
      current_workspace_id: auth.workspace,
      workspaces: rows.map((x) => ({
        id: x.workspace_id,
        slug: x.workspace_slug,
        name: x.workspace_name,
        role: x.role,
      })),
    };
  });

  // 1c. POST /v1/auth/switch-workspace — 換到同一個人的另一個 workspace（免重新輸入密碼）
  //     伺服器仍會核對該 membership 屬於同一 user，token 由伺服器重簽（ISO-3 不變）。
  app.post<{ Body: { workspace_id?: string } }>("/v1/auth/switch-workspace", async (req, reply) => {
    const { verifyJwt } = await import("./jwt.js");
    const auth = verifyJwt(req.headers.authorization);
    if (!auth) return reply.code(401).send({ type: "…/unauthorized", title: "unauthorized", status: 401 });
    // agent token 不得用來切換工作區（它綁定單一 workspace 的授權）
    if ((auth.scope?.length ?? 0) > 0 || auth.user_sub) {
      return reply.code(403).send({ type: "…/forbidden", title: "forbidden", status: 403 });
    }
    const target = req.body?.workspace_id;
    if (!target) {
      return reply.code(422).send({ type: "…/validation", title: "workspace_id required", status: 422 });
    }
    const rows = await memberships(auth.sub);
    const picked = rows?.find((x) => x.workspace_id === target);
    if (!picked) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    const token = signJwt({
      sub: picked.membership_id,
      workspace: picked.workspace_id,
      roles: [picked.role],
    });
    return { access_token: token, token_type: "Bearer", expires_in: USER_ACCESS_TOKEN_TTL_SEC, me: meFromRow(picked) };
  });

  // 1d. POST /v1/auth/workspaces — 已登入的人再建立一個 workspace（同一帳號多情境）
  //     與 register 的差別：不建新使用者，只多開一個 workspace 並把自己設為 admin。
  //     原子性：workspace + membership + calendar 同一交易，任一步失敗整筆 rollback。
  //     回傳新 workspace 的 token（等同建立後直接切過去），形狀與 login／switch 一致。
  app.post<{ Body: { name?: string; timezone?: string } }>("/v1/auth/workspaces", async (req, reply) => {
    const { verifyJwt } = await import("./jwt.js");
    const auth = verifyJwt(req.headers.authorization);
    if (!auth) return reply.code(401).send({ type: "…/unauthorized", title: "unauthorized", status: 401 });
    // agent token 不得建立 workspace（它只被授權操作綁定的那一個）
    if ((auth.scope?.length ?? 0) > 0 || auth.user_sub) {
      return reply.code(403).send({ type: "…/forbidden", title: "forbidden", status: 403 });
    }
    const parsed = CreateWorkspaceInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({
        type: "…/validation",
        title: "Unprocessable",
        status: 422,
        detail: parsed.error.issues.map((i) => i.message).join("；"),
      });
    }
    const rows = await memberships(auth.sub);
    const current = rows?.find((x) => x.membership_id === auth.sub) ?? rows?.[0];
    if (!rows || !current) {
      return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    }
    // 資源耗盡防護：一個帳號能擁有的 workspace 數量設上限（每個 workspace 都會長出資料）
    if (rows.length >= WORKSPACE_MAX_PER_USER) {
      return reply.code(409).send({
        type: "…/conflict",
        title: "too many workspaces",
        status: 409,
        detail: `一個帳號最多 ${WORKSPACE_MAX_PER_USER} 個工作區。`,
      });
    }
    const name = parsed.data.name; // schema 已 trim 並拒絕純空白
    const timezone = validTimezone(parsed.data.timezone) ?? current.timezone;

    const client = await adminPool().connect();
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const slug = slugify(name, attempt);
        try {
          await client.query("BEGIN");
          const ws = (
            await client.query(`INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id`, [name, slug])
          ).rows[0].id as string;
          // user_id 取自現有 membership，確保新 workspace 綁在同一個帳號上
          const membershipId = (
            await client.query(
              `INSERT INTO memberships(workspace_id,user_id,role,timezone)
               SELECT $1, user_id, 'admin', $2 FROM memberships WHERE id = $3
               RETURNING id`,
              [ws, timezone, auth.sub],
            )
          ).rows[0].id as string;
          await client.query(`INSERT INTO calendars(workspace_id,owner_id,name) VALUES($1,$2,$3)`, [
            ws,
            membershipId,
            `${current.display_name} calendar`,
          ]);
          await client.query("COMMIT");
          const token = signJwt({ sub: membershipId, workspace: ws, roles: ["admin"] });
          return reply.code(201).send({
            access_token: token,
            token_type: "Bearer",
            expires_in: USER_ACCESS_TOKEN_TTL_SEC,
            me: meFromRow({
              membership_id: membershipId,
              role: "admin",
              timezone,
              workspace_id: ws,
              workspace_slug: slug,
              workspace_name: name,
              display_name: current.display_name,
              email: current.email,
            }),
          });
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          // slug 撞號才重試，其他錯誤直接往外拋
          const code = (e as { code?: string }).code;
          if (code !== "23505" || attempt === 4) throw e;
        }
      }
      return reply.code(409).send({
        type: "…/conflict",
        title: "slug conflict",
        status: 409,
        detail: "工作區名稱產生的代稱重複，請換個名稱再試。",
      });
    } finally {
      client.release();
    }
  });

  // 2. POST /v1/auth/register — 自助註冊：建立新 workspace + 使用者（admin）+ 預設日曆
  //    原子性：四張表在同一交易內，任一步失敗整筆 rollback（不留半套帳號）。
  //    註冊完直接回 token（等同自動登入），流程與 login 回應同形狀。
  app.post("/v1/auth/register", async (req, reply) => {
    if (!REGISTRATION_ENABLED) {
      return reply.code(403).send({
        type: "…/forbidden",
        title: "registration disabled",
        status: 403,
        detail: "此站台未開放自助註冊。",
      });
    }
    const parsed = RegisterInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({
        type: "…/validation",
        title: "Unprocessable",
        status: 422,
        detail: parsed.error.issues.map((i) => i.message).join("；"),
      });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const { password, display_name, workspace_name } = parsed.data;
    // 時區只接受 Intl 認得的 IANA 值，否則退回 UTC（不讓任意字串進 DB）
    const timezone = validTimezone(parsed.data.timezone) ?? "UTC";

    // 濫用防護：同一來源 IP 短時間內大量註冊會建立大量 workspace（資源耗盡面）
    if (await tooManyRegistrations(req.ip)) {
      return reply.code(429).send({
        type: "…/too-many-requests",
        title: "too many registrations",
        status: 429,
        detail: "註冊次數過多，請稍後再試。",
      });
    }

    const passwordHash = await hashPassword(password);
    const client = await adminPool().connect();
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const slug = slugify(workspace_name, attempt);
        try {
          await client.query("BEGIN");
          const ws = (
            await client.query(`INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id`, [
              workspace_name,
              slug,
            ])
          ).rows[0].id as string;
          const userId = (
            await client.query(
              `INSERT INTO users(email,display_name,password_hash) VALUES($1,$2,$3) RETURNING id`,
              [email, display_name, passwordHash],
            )
          ).rows[0].id as string;
          const membershipId = (
            await client.query(
              `INSERT INTO memberships(workspace_id,user_id,role,timezone)
               VALUES($1,$2,'admin',$3) RETURNING id`,
              [ws, userId, timezone],
            )
          ).rows[0].id as string;
          await client.query(
            `INSERT INTO calendars(workspace_id,owner_id,name) VALUES($1,$2,$3)`,
            [ws, membershipId, `${display_name} calendar`],
          );
          await client.query("COMMIT");
          await noteRegistration(req.ip);

          const token = signJwt({ sub: membershipId, workspace: ws, roles: ["admin"] });
          return reply.code(201).send({
            access_token: token,
            token_type: "Bearer",
            expires_in: USER_ACCESS_TOKEN_TTL_SEC,
            me: meFromRow({
              membership_id: membershipId,
              role: "admin",
              timezone,
              workspace_id: ws,
              workspace_slug: slug,
              workspace_name,
              display_name,
              email,
            }),
          });
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          const code = (e as { code?: string }).code;
          const constraint = (e as { constraint?: string }).constraint ?? "";
          if (code !== "23505") throw e; // 非唯一鍵衝突 → 交給上層 500
          // email 已被註冊 → 明確告知（換 slug 重試也不會成功）
          if (constraint.includes("users") || constraint.includes("email")) {
            return reply.code(409).send({
              type: "…/conflict",
              title: "email already registered",
              status: 409,
              detail: "此電子郵件已註冊，請直接登入。",
            });
          }
          // workspace slug 撞名 → 換一個 slug 再試
        }
      }
      return reply.code(409).send({
        type: "…/conflict",
        title: "workspace slug conflict",
        status: 409,
        detail: "無法為此名稱產生可用的 workspace 代稱，請換個名稱。",
      });
    } finally {
      client.release();
    }
  });

  // 4. GET /v1/me — 當前身分 + roles（脈絡來自 token）
  //    使用者 token：sub=membership id → 回本人身分。
  //    agent M2M token：sub=agent_id（非 uuid）、user_sub=授權者 membership →
  //      回「我是哪個 agent、代表誰、有哪些 scope」，讓外部 agent 能自我確認身分
  //      （舊實作直接把 agent_id 當 uuid 查 memberships，會 500 並洩漏 DB 錯誤）。
  app.get("/v1/auth/me", async (req, reply) => {
    // 此端點在 /v1/auth/* 白名單內，故 onRequest 未注入 auth，這裡自行驗證。
    const { verifyJwt } = await import("./jwt.js");
    const auth = verifyJwt(req.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ type: "…/unauthorized", title: "unauthorized", status: 401 });
    }
    // agent token 以 user_sub 代表「代誰操作」；使用者 token 用 sub 本身。
    const isAgent = !UUID_RE.test(auth.sub);
    const membershipId = isAgent ? auth.user_sub : auth.sub;
    if (!membershipId || !UUID_RE.test(membershipId)) {
      // agent token 未帶 user_sub（例如僅供機器用途的舊 token）→ 無可對映的人
      return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    }
    const r = await adminPool().query(
      `SELECT m.id AS membership_id, m.role, m.timezone, m.workspace_id,
              w.slug AS workspace_slug, w.name AS workspace_name,
              u.display_name, u.email
         FROM memberships m
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id
        WHERE m.id = $1 AND m.workspace_id = $2
        LIMIT 1`,
      [membershipId, auth.workspace],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    const me = meFromRow(row);
    if (!isAgent) return me;
    // agent：明確標示這是「代理身分」，並附上 agent 自己的識別與 scope
    return {
      ...me,
      actor_type: "agent" as const,
      agent_id: auth.sub,
      scope: auth.scope ?? [],
      on_behalf_of: membershipId,
    };
  });
}

/** membership id 是 uuid；agent token 的 sub 是自訂字串，用它區分兩種 token。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function meFromRow(row: {
  membership_id: string;
  role: string;
  timezone: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  display_name: string;
  email: string;
}) {
  return {
    membership_id: row.membership_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    timezone: row.timezone,
    workspace: {
      id: row.workspace_id,
      slug: row.workspace_slug,
      name: row.workspace_name,
    },
  };
}
