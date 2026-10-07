import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { signJwt, verifyJwt } from "../src/auth/jwt.js";
import Redis from "ioredis";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

function redisClient() {
  return new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
  });
}

let app: ReturnType<typeof buildServer>;
let r: Redis;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
  r = redisClient();
});

afterAll(async () => {
  await app.close();
  r.disconnect();
});

describe("Refresh Token 機制", () => {
  it("登入時應核發 access_token 與 refresh_token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    
    // Check if refresh token has type: "refresh"
    const parsed = verifyJwt("Bearer " + body.refresh_token);
    expect(parsed?.type).toBe("refresh");
    expect(parsed?.jti).toBeTruthy();
  });

  it("使用合法的 refresh_token 可以換取新的 Token Pair", async () => {
    // 1. 先登入取得 refresh_token
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { refresh_token } = loginRes.json();
    
    // 2. 換取新 token
    const refreshRes = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token },
    });
    expect(refreshRes.statusCode).toBe(200);
    const body = refreshRes.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.refresh_token).not.toBe(refresh_token); // Should issue a new refresh token
  });

  it("使用 access_token 去呼叫 /refresh 會被拒絕 (type 錯誤)", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { access_token } = loginRes.json();
    
    const refreshRes = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token: access_token }, // passing access_token instead
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it("被換過 (已註銷) 的 refresh_token 不能再次使用 (Rotation 防護)", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { refresh_token } = loginRes.json();
    
    // 第 1 次換取 (成功)
    const refresh1 = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token },
    });
    expect(refresh1.statusCode).toBe(200);
    
    // 第 2 次換取使用舊的 token (失敗，因已被註銷)
    const refresh2 = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token },
    });
    expect(refresh2.statusCode).toBe(401);
  });

  it("呼叫 /logout 可主動撤銷 refresh_token", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { refresh_token } = loginRes.json();
    
    // 主動撤銷
    const logoutRes = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refresh_token },
    });
    expect(logoutRes.statusCode).toBe(200);
    
    // 撤銷後嘗試 refresh 應失敗
    const refreshRes = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token },
    });
    expect(refreshRes.statusCode).toBe(401);
  });
});
