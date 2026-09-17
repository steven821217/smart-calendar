import type { PoolClient } from "pg";
import { withWorkspace } from "../db/pool.js";

export type ActorType = "user" | "agent" | "system";

export interface AuditEntry {
  actor_id?: string | null; // users.id（人）；agent 無對映則 null
  actor_type: ActorType;
  on_behalf_of?: string | null; // 代排時的實際使用者 membership/user
  agent_id?: string | null; // agent token 識別（sub）
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  decision?: string | null; // allow / deny
  metadata?: Record<string, unknown>;
}

/**
 * 寫一筆稽核（MCP-13）。一律在 workspace 脈絡交易內 → RLS 兜底，
 * 不會把某 workspace 的稽核寫到別人身上。可傳入既有 client 併入同一交易。
 */
export async function writeAudit(workspaceId: string, e: AuditEntry, client?: PoolClient) {
  const run = async (c: PoolClient) => {
    await c.query(
      `INSERT INTO audit_log
         (workspace_id, actor_id, actor_type, on_behalf_of, agent_id,
          action, target_type, target_id, decision, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        workspaceId,
        e.actor_id ?? null,
        e.actor_type,
        e.on_behalf_of ?? null,
        e.agent_id ?? null,
        e.action,
        e.target_type ?? null,
        e.target_id ?? null,
        e.decision ?? null,
        JSON.stringify(e.metadata ?? {}),
      ],
    );
  };
  if (client) return run(client);
  return withWorkspace(workspaceId, run);
}

export interface AuditQuery {
  actor_type?: ActorType;
  agent_id?: string;
  limit?: number;
  before?: string; // ISO；分頁游標（at < before）
}

/** 讀稽核時間軸（audit.read / agent.manage）。RLS 限定本 workspace。 */
export async function listAudit(workspaceId: string, q: AuditQuery = {}) {
  return withWorkspace(workspaceId, async (c) => {
    const clauses: string[] = ["workspace_id = $1"];
    const params: unknown[] = [workspaceId];
    if (q.actor_type) {
      params.push(q.actor_type);
      clauses.push(`actor_type = $${params.length}`);
    }
    if (q.agent_id) {
      params.push(q.agent_id);
      clauses.push(`agent_id = $${params.length}`);
    }
    if (q.before) {
      params.push(q.before);
      clauses.push(`at < $${params.length}`);
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    params.push(limit);
    const r = await c.query(
      `SELECT id, actor_id, actor_type, on_behalf_of, agent_id, action,
              target_type, target_id, decision, metadata, at
         FROM audit_log
        WHERE ${clauses.join(" AND ")}
        ORDER BY at DESC
        LIMIT $${params.length}`,
      params,
    );
    const rows = r.rows;
    const next_cursor =
      rows.length === limit ? new Date(rows[rows.length - 1].at).toISOString() : null;
    return { entries: rows, next_cursor };
  });
}
