import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;

const NEW_MEMBER_EMAIL = "new-invite@example.com";

async function cleanup() {
  const c = adminClient();
  await c.connect();
  // 刪除被邀請的使用者
  // 先刪除建立的 calendars，避免 foreign key constraint "calendars_owner_id_fkey"
  await c.query(`DELETE FROM calendars WHERE owner_id IN (SELECT id FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email = $1))`, [NEW_MEMBER_EMAIL]);
  await c.query(`DELETE FROM users WHERE email = $1`, [NEW_MEMBER_EMAIL]);
  await c.end();
}

beforeAll(async () => {
  await cleanup();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe("POST /v1/auth/workspaces/members", () => {
  it("Admin 可以邀請新成員加入目前的 Workspace", async () => {
    // 1. admin 登入
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { access_token } = loginRes.json();
    
    // 2. 邀請新成員
    const inviteRes = await app.inject({
      method: "POST",
      url: "/v1/auth/workspaces/members",
      headers: { authorization: `Bearer ${access_token}` },
      payload: { email: NEW_MEMBER_EMAIL, role: "member", display_name: "New Member" },
    });
    expect(inviteRes.statusCode).toBe(201);
    const body = inviteRes.json();
    expect(body.status).toBe("invited");
    expect(body.email).toBe(NEW_MEMBER_EMAIL);
    expect(body.role).toBe("member");
    
    // 3. 確認資料庫中是否有該 user 與 membership
    const c = adminClient();
    await c.connect();
    const userRes = await c.query("SELECT * FROM users WHERE email = $1", [NEW_MEMBER_EMAIL]);
    expect(userRes.rows.length).toBe(1);
    expect(userRes.rows[0].password_hash).toBeNull(); // 新邀請的使用者尚未設定密碼
    
    const membershipRes = await c.query("SELECT * FROM memberships WHERE user_id = $1", [userRes.rows[0].id]);
    expect(membershipRes.rows.length).toBe(1);
    expect(membershipRes.rows[0].role).toBe("member");
    await c.end();
  });

  it("拒絕重複邀請已經在 Workspace 內的成員", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { access_token } = loginRes.json();
    
    const inviteRes = await app.inject({
      method: "POST",
      url: "/v1/auth/workspaces/members",
      headers: { authorization: `Bearer ${access_token}` },
      payload: { email: NEW_MEMBER_EMAIL, role: "member", display_name: "New Member" }, // 剛才已經邀請過
    });
    expect(inviteRes.statusCode).toBe(409); // Conflict
  });

  it("Admin 可以變更成員權限", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { access_token } = loginRes.json();

    const c = adminClient();
    await c.connect();
    const membershipRes = await c.query("SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [NEW_MEMBER_EMAIL]);
    const membershipId = membershipRes.rows[0].id;
    await c.end();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/auth/workspaces/members/${membershipId}`,
      headers: { authorization: `Bearer ${access_token}` },
      payload: { role: "scheduler" },
    });
    expect(patchRes.statusCode).toBe(200);

    const c2 = adminClient();
    await c2.connect();
    const roleCheck = await c2.query("SELECT role FROM memberships WHERE id = $1", [membershipId]);
    expect(roleCheck.rows[0].role).toBe("scheduler");
    await c2.end();
  });

  it("Admin 可以移除成員 (軟刪除)", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a@example.com", password: "demo-password-1234" },
    });
    const { access_token } = loginRes.json();

    const c = adminClient();
    await c.connect();
    const membershipRes = await c.query("SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [NEW_MEMBER_EMAIL]);
    const membershipId = membershipRes.rows[0].id;
    await c.end();

    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/auth/workspaces/members/${membershipId}`,
      headers: { authorization: `Bearer ${access_token}` },
    });
    if (delRes.statusCode !== 204) console.log(delRes.json());
    expect(delRes.statusCode).toBe(204);

    const c2 = adminClient();
    await c2.connect();
    const statusCheck = await c2.query("SELECT status FROM memberships WHERE id = $1", [membershipId]);
    expect(statusCheck.rows[0].status).toBe("inactive");
    await c2.end();
  });
});
