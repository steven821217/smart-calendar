import pg from "pg";

// seed 用 admin 連線（跨 workspace 建立示範資料，不受 RLS 限制以便建置 fixtures）
const adminUrl =
  process.env.ADMIN_DATABASE_URL ??
  `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`;

async function main() {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query("BEGIN");
    // 冪等：先清示範資料
    await c.query(`DELETE FROM workspaces WHERE slug IN ('ws-a','ws-b')`);
    await c.query(`DELETE FROM users WHERE email IN ('a@example.com','b@example.com')`);

    const mk = async (slug: string, email: string, name: string) => {
      const ws = (await c.query(
        `INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id`,
        [name, slug],
      )).rows[0].id;
      const user = (await c.query(
        `INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id`,
        [email, name],
      )).rows[0].id;
      const mem = (await c.query(
        `INSERT INTO memberships(workspace_id,user_id,role,timezone) VALUES($1,$2,'admin','Asia/Taipei') RETURNING id`,
        [ws, user],
      )).rows[0].id;
      const cal = (await c.query(
        `INSERT INTO calendars(workspace_id,owner_id,name) VALUES($1,$2,$3) RETURNING id`,
        [ws, mem, `${name} calendar`],
      )).rows[0].id;
      await c.query(
        `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by)
         VALUES($1,$2,$3,'2026-09-15T06:00:00Z','2026-09-15T06:30:00Z','Asia/Taipei',$4)`,
        [ws, cal, `${name} event`, mem],
      );
      return { ws, cal, mem };
    };

    const a = await mk("ws-a", "a@example.com", "Workspace A");
    const b = await mk("ws-b", "b@example.com", "Workspace B");
    await c.query("COMMIT");
    console.log("seed: OK", JSON.stringify({ a, b }));
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("seed FAILED:", e);
  process.exit(1);
});
