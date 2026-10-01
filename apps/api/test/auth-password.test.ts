import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

/**
 * 密碼認證（3.1 正式化）。
 *
 * 鎖住的性質：
 *  - scrypt 雜湊：同一密碼兩次雜湊不同（隨機 salt）、可驗證、錯誤密碼不通過。
 *  - 格式異常 / 未設密碼 → verifyPassword 一律 false（fail-closed，不拋例外）。
 *  - 登入必須帶密碼；缺密碼 → 422。
 *  - 帳號不存在、密碼錯誤 → 同樣的 401（不洩漏帳號是否存在）。
 *  - 未設密碼的既有帳號無法登入（不得以空密碼繞過）。
 *  - 密碼正確 → 200 + token。
 */

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "demo-password-1234";

function jwtTimes(token: string): { iat: number; exp: number } {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;
/** 一個「有 membership 但沒有設密碼」的帳號，驗證 fail-closed。 */
const NOPASS_EMAIL = "nopass-test@example.com";

beforeAll(async () => {
  const c = adminClient();
  await c.connect();
  const ws = (await c.query(`SELECT id FROM workspaces WHERE slug='ws-a' LIMIT 1`)).rows[0].id;
  await c.query(`DELETE FROM users WHERE email=$1`, [NOPASS_EMAIL]);
  const uid = (
    await c.query(
      `INSERT INTO users(email,display_name,password_hash) VALUES($1,'No Password',NULL) RETURNING id`,
      [NOPASS_EMAIL],
    )
  ).rows[0].id;
  await c.query(
    `INSERT INTO memberships(workspace_id,user_id,role,timezone) VALUES($1,$2,'member','Asia/Taipei')`,
    [ws, uid],
  );
  await c.end();

  // 節流不影響本測試（多次故意失敗）
  process.env.LOGIN_THROTTLE = "0";
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const c = adminClient();
  await c.connect();
  await c.query(`DELETE FROM users WHERE email=$1`, [NOPASS_EMAIL]);
  await c.end();
});

const doLogin = (payload: unknown) =>
  app.inject({ method: "POST", url: "/v1/auth/login", payload });

describe("password hashing（scrypt，node:crypto）", () => {
  it("同一密碼兩次雜湊不同（隨機 salt），但都能驗證通過", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("correct horse battery staple", b)).toBe(true);
  });

  it("錯誤密碼不通過；雜湊字串不含原始密碼", async () => {
    const h = await hashPassword("s3cret-password");
    expect(await verifyPassword("wrong-password", h)).toBe(false);
    expect(h.includes("s3cret-password")).toBe(false);
  });

  it("未設密碼 / 格式壞掉 / 空密碼 → false（fail-closed，不拋例外）", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$bad$8$1$aaaa$bbbb")).toBe(false);
    expect(await verifyPassword("", await hashPassword("abc"))).toBe(false);
  });
});

describe("POST /v1/auth/login（email + 密碼）", () => {
  it("正確密碼 → 200 + token + me", async () => {
    const res = await doLogin({ email: "a@example.com", password: DEMO_PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.expires_in).toBe(3600);
    const { iat, exp } = jwtTimes(body.access_token);
    expect(exp - iat).toBe(3600);
    expect(body.me.email).toBe("a@example.com");
  });

  it("缺密碼 → 422（不得只靠 email 就發 token）", async () => {
    expect((await doLogin({ email: "a@example.com" })).statusCode).toBe(422);
    expect((await doLogin({ email: "a@example.com", password: "" })).statusCode).toBe(422);
  });

  it("密碼錯誤 → 401", async () => {
    const res = await doLogin({ email: "a@example.com", password: "definitely-wrong" });
    expect(res.statusCode).toBe(401);
  });

  it("帳號不存在與密碼錯誤回應完全相同（不洩漏帳號是否存在）", async () => {
    const missing = await doLogin({ email: "no-such-user@example.com", password: "whatever-123" });
    const wrong = await doLogin({ email: "a@example.com", password: "definitely-wrong" });
    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.json()).toEqual(wrong.json());
  });

  it("既有帳號未設密碼 → 無法登入（空密碼/任意密碼皆 401 或 422）", async () => {
    expect((await doLogin({ email: NOPASS_EMAIL, password: "anything-goes" })).statusCode).toBe(401);
    // 空密碼被 422 擋在更前面，同樣拿不到 token
    expect((await doLogin({ email: NOPASS_EMAIL, password: "" })).statusCode).toBe(422);
  });

  it("過長密碼 → 422（不讓 KDF 為無意義輸入做工）", async () => {
    const res = await doLogin({ email: "a@example.com", password: "x".repeat(5000) });
    expect(res.statusCode).toBe(422);
  });
});
