import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { verifyJwt } from "../src/auth/jwt.js";

/**
 * 自助註冊（POST /v1/auth/register）。
 *
 * 鎖住的性質：
 *  - 註冊建立「新 workspace + 使用者 + admin membership + 預設日曆」，回 201 + token（自動登入）。
 *  - 新帳號可立即用該密碼登入（密碼確實有雜湊寫入）。
 *  - email 全域唯一：重複註冊 → 409，且**不得**留下半套資料（交易原子性）。
 *  - 密碼太短 / email 格式錯 / 缺欄位 → 422。
 *  - 新 workspace 與既有 workspace 互相隔離（ISO：token 只帶自己的 workspace）。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;
const EMAILS = ["reg-new@example.com", "reg-dup@example.com", "reg-atomic@example.com"];

async function cleanup() {
  const c = adminClient();
  await c.connect();
  // 先刪 workspace（cascade 掉 membership/calendar），再刪 user
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
  process.env.LOGIN_THROTTLE = "0"; // 不讓節流干擾重複註冊/登入測試
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanup();
});

const register = (payload: unknown) =>
  app.inject({ method: "POST", url: "/v1/auth/register", payload });

describe("POST /v1/auth/register", () => {
  it("成功註冊 → 201 + token + admin membership + 新 workspace", async () => {
    const res = await register({
      email: "reg-new@example.com",
      password: "a-good-password",
      display_name: "New User",
      workspace_name: "新使用者的團隊",
      timezone: "Asia/Taipei",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.expires_in).toBe(3600);
    expect(body.me.email).toBe("reg-new@example.com");
    expect(body.me.role).toBe("admin");
    expect(body.me.timezone).toBe("Asia/Taipei");
    expect(body.me.workspace.name).toBe("新使用者的團隊");
    // token 內的 workspace/sub 與回應一致
    const claims = verifyJwt(`Bearer ${body.access_token}`);
    expect(claims!.workspace).toBe(body.me.workspace.id);
    expect(claims!.sub).toBe(body.me.membership_id);
    expect(claims!.roles).toEqual(["admin"]);

    // 預設日曆已建立（用 admin 連線核對）
    const c = adminClient();
    await c.connect();
    const cal = await c.query(`SELECT count(*)::int AS n FROM calendars WHERE workspace_id=$1`, [
      body.me.workspace.id,
    ]);
    await c.end();
    expect(cal.rows[0].n).toBe(1);
  });

  it("註冊後可立即用該密碼登入（密碼確實雜湊寫入）", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "reg-new@example.com", password: "a-good-password" },
    });
    expect(login.statusCode).toBe(200);
    // 錯密碼仍然擋掉
    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "reg-new@example.com", password: "a-good-passwordX" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("email 重複 → 409，且不留下多餘的 workspace（交易 rollback）", async () => {
    const first = await register({
      email: "reg-dup@example.com",
      password: "another-password",
      display_name: "Dup",
      workspace_name: "重複測試",
    });
    expect(first.statusCode).toBe(201);

    const c = adminClient();
    await c.connect();
    const before = (await c.query(`SELECT count(*)::int AS n FROM workspaces`)).rows[0].n as number;

    const second = await register({
      email: "reg-dup@example.com",
      password: "another-password",
      display_name: "Dup2",
      workspace_name: "重複測試2",
    });
    expect(second.statusCode).toBe(409);

    const after = (await c.query(`SELECT count(*)::int AS n FROM workspaces`)).rows[0].n as number;
    await c.end();
    expect(after).toBe(before); // 沒有殘留半套 workspace
  });

  it("密碼太短 / email 格式錯 / 缺欄位 → 422", async () => {
    expect(
      (await register({ email: "reg-atomic@example.com", password: "short", display_name: "A", workspace_name: "B" }))
        .statusCode,
    ).toBe(422);
    expect(
      (await register({ email: "not-an-email", password: "a-good-password", display_name: "A", workspace_name: "B" }))
        .statusCode,
    ).toBe(422);
    expect((await register({ email: "reg-atomic@example.com", password: "a-good-password" })).statusCode).toBe(422);
  });

  it("非法時區 → 退回 UTC（不讓任意字串進 DB）", async () => {
    const res = await register({
      email: "reg-atomic@example.com",
      password: "a-good-password",
      display_name: "TZ",
      workspace_name: "時區測試",
      timezone: "Mars/Olympus_Mons",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().me.timezone).toBe("UTC");
  });

  it("新 workspace 與 ws-a 不同（隔離：token 只帶自己的 workspace）", async () => {
    const c = adminClient();
    await c.connect();
    const wsA = (await c.query(`SELECT id FROM workspaces WHERE slug='ws-a' LIMIT 1`)).rows[0].id;
    const mine = (
      await c.query(
        `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=$1`,
        ["reg-new@example.com"],
      )
    ).rows[0].workspace_id;
    await c.end();
    expect(mine).not.toBe(wsA);
  });
});
