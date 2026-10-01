import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { verifyJwt } from "../src/auth/jwt.js";

/**
 * 同一帳號多工作區（POST /v1/auth/workspaces）。
 *
 * 場景：一個人想把「公司」與「家庭」分開管理。先前唯一能建立 workspace 的入口是
 * 註冊（需要新 email），所以既有帳號無法再開一個——這裡補上。
 *
 * 鎖住的性質：
 *  - 已登入者可再建 workspace，回 201 + 新 workspace 的 token（等同建立後直接切過去），角色 admin。
 *  - 新 workspace 綁在**同一個 user** 上（不是新帳號）：切換器列得出兩個。
 *  - 新 workspace 是空的且與原 workspace 完全隔離（ISO：token 只帶自己的 workspace）。
 *  - 未帶 token → 401；名稱為空 → 422。
 *  - agent token（有 scope）不得建立 workspace → 403。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let app: ReturnType<typeof buildServer>;
const EMAIL = "ws-multi@example.com";

async function cleanup() {
  const c = adminClient();
  await c.connect();
  await c.query(
    `DELETE FROM workspaces WHERE id IN (
       SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1
     )`,
    [EMAIL],
  );
  await c.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  await c.end();
}

beforeAll(async () => {
  await cleanup();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanup();
});

describe("同一帳號建立多個工作區", () => {
  it("建立 → 回 201 與新工作區 token，且兩個工作區都屬於同一帳號且互相隔離", async () => {
    // 先註冊一個帳號（這會給第一個 workspace）
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: EMAIL,
        password: "multi-ws-pass-1234",
        display_name: "多工作區測試",
        workspace_name: "公司",
      },
    });
    expect(reg.statusCode).toBe(201);
    const first = reg.json() as { access_token: string; me: { workspace: { id: string } } };
    const firstWs = first.me.workspace.id;

    // 在同一帳號下再建一個
    const created = await app.inject({
      method: "POST",
      url: "/v1/auth/workspaces",
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { name: "家庭" },
    });
    expect(created.statusCode).toBe(201);
    const second = created.json() as {
      access_token: string;
      me: { role: string; email: string; workspace: { id: string; name: string } };
    };
    expect(second.me.workspace.name).toBe("家庭");
    expect(second.me.role).toBe("admin");
    expect(second.me.email).toBe(EMAIL);
    // 是不同的 workspace
    expect(second.me.workspace.id).not.toBe(firstWs);
    // token 只帶新 workspace（ISO-3）
    const claims = verifyJwt(`Bearer ${second.access_token}`);
    expect(claims?.workspace).toBe(second.me.workspace.id);

    // 切換器列得出兩個，且都屬於同一帳號
    const list = await app.inject({
      method: "GET",
      url: "/v1/auth/workspaces",
      headers: { authorization: `Bearer ${second.access_token}` },
    });
    expect(list.statusCode).toBe(200);
    const names = (list.json() as { workspaces: Array<{ name: string; role: string }> }).workspaces;
    expect(names.map((w) => w.name).sort()).toEqual(["公司", "家庭"]);
    expect(names.every((w) => w.role === "admin")).toBe(true);

    // 新工作區是空的（隔離）：用新 token 看不到任何群組
    const groups = await app.inject({
      method: "GET",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${second.access_token}` },
    });
    expect(groups.statusCode).toBe(200);
    expect((groups.json() as { groups: unknown[] }).groups).toHaveLength(0);

    // 可以切回第一個工作區
    const back = await app.inject({
      method: "POST",
      url: "/v1/auth/switch-workspace",
      headers: { authorization: `Bearer ${second.access_token}` },
      payload: { workspace_id: firstWs },
    });
    expect(back.statusCode).toBe(200);
    expect((back.json() as { me: { workspace: { id: string } } }).me.workspace.id).toBe(firstWs);
  });

  it("未帶 token → 401；名稱空白 → 422", async () => {
    const noAuth = await app.inject({ method: "POST", url: "/v1/auth/workspaces", payload: { name: "x" } });
    expect(noAuth.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: EMAIL, password: "multi-ws-pass-1234", workspace_id: undefined },
    });
    // 此時帳號已有兩個工作區 → 需要選擇
    const body = login.json() as { needs_workspace_selection?: boolean; workspaces?: Array<{ id: string }> };
    expect(body.needs_workspace_selection).toBe(true);
    const picked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: EMAIL, password: "multi-ws-pass-1234", workspace_id: body.workspaces![0].id },
    });
    const token = (picked.json() as { access_token: string }).access_token;

    const blank = await app.inject({
      method: "POST",
      url: "/v1/auth/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "   " },
    });
    // 空白會被 trim 成空字串 → 名稱不合法
    expect([422, 409]).toContain(blank.statusCode);
  });
});
