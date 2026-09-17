import { randomBytes } from "node:crypto";
import { withWorkspace } from "../db/pool.js";

export interface CreateWebhookArgs {
  url: string;
  events: string[];
  secret?: string;
}

/** 建立 webhook 訂閱。未帶 secret 則產生 32-byte hex（回傳一次，供訂閱者存）。 */
export async function createWebhook(workspaceId: string, args: CreateWebhookArgs) {
  const secret = args.secret ?? randomBytes(32).toString("hex");
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `INSERT INTO webhooks(workspace_id, url, secret, events)
       VALUES($1,$2,$3,$4) RETURNING id, url, events, active, created_at`,
      [workspaceId, args.url, secret, args.events],
    );
    // secret 僅在建立時回傳一次
    return { ...r.rows[0], secret };
  });
}

/** 列 webhook（不回 secret）。 */
export async function listWebhooks(workspaceId: string) {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT id, url, events, active, created_at FROM webhooks ORDER BY created_at DESC`,
    );
    return r.rows;
  });
}

/** 刪除 webhook（RLS 兜底，跨 ws 影響 0 筆）。回傳是否刪到。 */
export async function deleteWebhook(workspaceId: string, id: string): Promise<boolean> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(`DELETE FROM webhooks WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
