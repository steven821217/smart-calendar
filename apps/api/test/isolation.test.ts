import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { withWorkspace, pool } from "../src/db/pool.js";

// 取得 seed 建立的 ws_a / ws_b id（用 app_user 連線 + 各自脈絡讀自己）
async function getWorkspaceIds() {
  const admin = new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  await admin.connect();
  const rows = (
    await admin.query(`SELECT id, slug FROM workspaces WHERE slug IN ('ws-a','ws-b')`)
  ).rows;
  await admin.end();
  const a = rows.find((r) => r.slug === "ws-a").id;
  const b = rows.find((r) => r.slug === "ws-b").id;
  return { a, b };
}

let WS_A: string;
let WS_B: string;

beforeAll(async () => {
  const ids = await getWorkspaceIds();
  WS_A = ids.a;
  WS_B = ids.b;
});

describe("cross-workspace RLS isolation (ISO-*)", () => {
  it("ws_a 脈絡只看到 ws_a 的 events，看不到 ws_b", async () => {
    const rows = await withWorkspace(WS_A, async (c) => {
      return (await c.query("SELECT workspace_id FROM events")).rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.workspace_id === WS_A)).toBe(true);
    expect(rows.some((r) => r.workspace_id === WS_B)).toBe(false);
  });

  it("未設 workspace 脈絡 → 查詢回 0 筆 (ISO-4 deny-by-default)", async () => {
    const rows = await withWorkspace(null, async (c) => {
      return (await c.query("SELECT * FROM events")).rows;
    });
    expect(rows.length).toBe(0);
  });

  it("ws_a 脈絡下 INSERT workspace_id=ws_b 的 event → 被 WITH CHECK 拒絕", async () => {
    await expect(
      withWorkspace(WS_A, async (c) => {
        // 取 ws_a 自己的 calendar/membership 以滿足 FK，但故意塞 ws_b 的 workspace_id
        const cal = (
          await c.query("SELECT id FROM calendars LIMIT 1")
        ).rows[0].id;
        const mem = (
          await c.query("SELECT id FROM memberships LIMIT 1")
        ).rows[0].id;
        await c.query(
          `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by)
           VALUES($1,$2,'evil','2026-09-16T06:00:00Z','2026-09-16T07:00:00Z','UTC',$3)`,
          [WS_B, cal, mem],
        );
      }),
    ).rejects.toThrow();
  });

  it("ws_b 脈絡只看到 ws_b 的 events", async () => {
    const rows = await withWorkspace(WS_B, async (c) => {
      return (await c.query("SELECT workspace_id FROM events")).rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("連線角色非 superuser 且無 BYPASSRLS (ISO-5)", async () => {
    const r = await withWorkspace(WS_A, async (c) => {
      return (
        await c.query(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        )
      ).rows[0];
    });
    expect(r.rolsuper).toBe(false);
    expect(r.rolbypassrls).toBe(false);
  });
});
