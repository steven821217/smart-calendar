import pg from "pg";

const { Pool } = pg;

// 應用連線池：使用 app_user（NOBYPASSRLS），RLS 才會生效
export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    `postgres://app_user:${process.env.DB_PASSWORD ?? "change-me-appuser"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
});

/**
 * withWorkspace: 在單一交易內先 SET LOCAL app.current_workspace，再執行查詢。
 * LOCAL 隨交易結束自動失效，避免連線池把租戶脈絡洩漏給下一個請求 (ISO / TZ-safe)。
 * workspaceId 應來自已驗證的 JWT，而非 request body (ISO-3)。
 */
export async function withWorkspace<T>(
  workspaceId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (workspaceId) {
      // set_config(..., true) => LOCAL，隨交易結束失效
      await client.query("SELECT set_config('app.current_workspace', $1, true)", [
        workspaceId,
      ]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
