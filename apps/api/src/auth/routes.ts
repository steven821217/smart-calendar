import type { FastifyInstance } from "fastify";
import pg from "pg";
import { signJwt } from "./jwt.js";

/**
 * 認證端點（api.md 1/4）。
 *
 * ⚠️ 開發用簡化版（3.1）：以 email 對映到單一 membership 直接簽發 access token，
 * 尚未接密碼雜湊 / refresh / 撤銷黑名單（3.2 延後，見 tasks.md）。正式環境需改為
 * 驗證密碼 + RS256/JWKS + refresh token 輪替。workspace 脈絡只放進 token（ISO-3），
 * 前端永遠不能自行指定 workspace。
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

export function registerAuthRoutes(app: FastifyInstance) {
  // 1. POST /v1/auth/login — dev：email → membership → 簽 access token
  app.post<{ Body: { email?: string } }>("/v1/auth/login", async (req, reply) => {
    const email = req.body?.email?.trim().toLowerCase();
    if (!email) {
      return reply
        .code(422)
        .send({ type: "…/validation", title: "email required", status: 422 });
    }
    const r = await adminPool().query(
      `SELECT m.id AS membership_id, m.role, m.timezone, m.workspace_id,
              w.slug AS workspace_slug, w.name AS workspace_name,
              u.display_name, u.email
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE u.email = $1
        LIMIT 1`,
      [email],
    );
    const row = r.rows[0];
    if (!row) {
      // 不洩漏帳號是否存在
      return reply
        .code(401)
        .send({ type: "…/unauthorized", title: "invalid credentials", status: 401 });
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
      expires_in: 900,
      me: meFromRow(row),
    };
  });

  // 4. GET /v1/me — 當前使用者 + roles（脈絡來自 token）
  app.get("/v1/auth/me", async (req, reply) => {
    // 此端點在 /v1/auth/* 白名單內，故 onRequest 未注入 auth，這裡自行驗證。
    const { verifyJwt } = await import("./jwt.js");
    const auth = verifyJwt(req.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ type: "…/unauthorized", title: "unauthorized", status: 401 });
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
      [auth.sub, auth.workspace],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    return meFromRow(row);
  });
}

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
