import pg, { type PoolClient } from "pg";
import { withWorkspace } from "../db/pool.js";

/**
 * 團隊群組 Service（feature-team-groups Req 1）。
 * groups / group_members 皆帶 workspace_id，所有 SQL 走 withWorkspace（RLS 兜底）。
 * workspace 一律來自呼叫者已驗證的 context，不從 request body（ISO-3 / ZT-5）。
 */

export type GroupRole = "leader" | "member";

export interface GroupRow {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}

export interface GroupMemberRow {
  id: string;
  group_id: string;
  user_id: string;
  membership_id: string | null;
  display_name: string | null;
  role: GroupRole;
}

/** 列本 workspace 全部群組。 */
export async function listGroups(workspaceId: string): Promise<GroupRow[]> {
  return withWorkspace(workspaceId, async (c: PoolClient) => {
    const r = await c.query(
      `SELECT id, name, created_by, created_at FROM groups ORDER BY name`,
    );
    return r.rows as GroupRow[];
  });
}

export interface WorkspaceMemberRow {
  membership_id: string;
  user_id: string;
  display_name: string;
  role: string;
}

/** 列本 workspace 全部成員（含 user_id，供群組成員挑選器使用）。 */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT m.id AS membership_id, u.id AS user_id, u.display_name, m.role
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.status = 'active'
        ORDER BY u.display_name`,
    );
    return r.rows as WorkspaceMemberRow[];
  });
}

/**
 * 依 email 找本工作區的成員。
 *
 * 用途：邀請與會者時以 email 找人。刻意**只查本工作區**——回傳全站使用者會變成
 * email 列舉面（任何成員都能探測某個 email 是否在本平台註冊過）。
 * 查不到就是查不到，由呼叫端提示「請先把他加入工作區」。
 *
 * email 欄位是 citext，比對本身不分大小寫。
 */
export async function findWorkspaceMemberByEmail(
  workspaceId: string,
  email: string,
): Promise<WorkspaceMemberRow | null> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT m.id AS membership_id, u.id AS user_id, u.display_name, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.status = 'active' AND u.email = $1::citext
        LIMIT 1`,
      [email.trim()],
    );
    return (r.rows[0] as WorkspaceMemberRow) ?? null;
  });
}

/** 加入工作區成員的結果；kind 讓路由層決定 HTTP 狀態與訊息。 */
export type AddWorkspaceMemberResult =
  | { kind: "created"; member: WorkspaceMemberRow }
  | { kind: "not_registered" }
  | { kind: "already_member" };

/**
 * 把「已註冊」的使用者加入本 workspace 並指定角色（admin 專用）。
 *
 * 設計取捨（刻意不做邀請信流程）：對方必須先自己註冊，leader 再用 email 把他加進來。
 * 少一套 token/寄信/接受頁，也不會有「邀請未接受」的中間狀態。
 * 副作用：同時為他在本 workspace 建一本個人日曆，他自己建立的事件才有地方放，
 * 且個人隔離查詢（listOccurrencesForMember）是以 calendars.owner_id 判斷本人事件。
 *
 * 注意：users 是全域表、不受 workspace RLS 管，故 email 查詢用 admin 連線；
 * membership/calendar 的寫入仍在 withWorkspace 交易內（RLS 兜底）。
 */
export async function addWorkspaceMemberByEmail(
  workspaceId: string,
  email: string,
  role: "admin" | "scheduler" | "member",
  timezone?: string,
): Promise<AddWorkspaceMemberResult> {
  const admin = new pg.Pool({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  let userId: string;
  let displayName: string;
  try {
    const u = await admin.query(
      `SELECT id, display_name FROM users WHERE email = $1 AND password_hash IS NOT NULL LIMIT 1`,
      [email],
    );
    if (!u.rows[0]) return { kind: "not_registered" };
    userId = u.rows[0].id as string;
    displayName = u.rows[0].display_name as string;
  } finally {
    await admin.end();
  }

  return withWorkspace(workspaceId, async (c) => {
    const existing = await c.query(
      `SELECT id FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [workspaceId, userId],
    );
    if (existing.rows[0]) return { kind: "already_member" } as AddWorkspaceMemberResult;

    const membershipId = (
      await c.query(
        `INSERT INTO memberships(workspace_id,user_id,role,timezone)
         VALUES($1,$2,$3,COALESCE($4,'UTC')) RETURNING id`,
        [workspaceId, userId, role, timezone ?? null],
      )
    ).rows[0].id as string;
    await c.query(`INSERT INTO calendars(workspace_id,owner_id,name) VALUES($1,$2,$3)`, [
      workspaceId,
      membershipId,
      `${displayName} calendar`,
    ]);
    return {
      kind: "created",
      member: { membership_id: membershipId, user_id: userId, display_name: displayName, role },
    } as AddWorkspaceMemberResult;
  });
}

/** 建立群組（名稱在 workspace 內唯一）。 */
export async function createGroup(
  workspaceId: string,
  name: string,
  createdBy?: string | null,
): Promise<GroupRow> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `INSERT INTO groups(workspace_id, name, created_by) VALUES($1,$2,$3)
       RETURNING id, name, created_by, created_at`,
      [workspaceId, name, createdBy ?? null],
    );
    return r.rows[0] as GroupRow;
  });
}

/** 刪除群組（連帶 group_members，ON DELETE CASCADE）。回被刪 id 或 null。 */
export async function deleteGroup(workspaceId: string, groupId: string): Promise<string | null> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(`DELETE FROM groups WHERE id=$1 RETURNING id`, [groupId]);
    return r.rows[0]?.id ?? null;
  });
}

/**
 * 列群組成員（帶 membership_id 與 display_name，供委員會做名字/代名詞解析）。
 * user 未必在本 workspace 有 membership（理論上應有）；LEFT JOIN 兜底。
 */
export async function listGroupMembers(
  workspaceId: string,
  groupId: string,
): Promise<GroupMemberRow[]> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT gm.id, gm.group_id, gm.user_id, gm.role,
              m.id AS membership_id, u.display_name
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         LEFT JOIN memberships m ON m.user_id = gm.user_id AND m.workspace_id = gm.workspace_id
        WHERE gm.group_id = $1
        ORDER BY gm.role DESC, u.display_name`,
      [groupId],
    );
    return r.rows as GroupMemberRow[];
  });
}

/** 加入群組成員（冪等：同 group+user 更新 role）。 */
export async function addGroupMember(
  workspaceId: string,
  groupId: string,
  userId: string,
  role: GroupRole = "member",
): Promise<GroupMemberRow> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `INSERT INTO group_members(workspace_id, group_id, user_id, role)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, group_id, user_id, role`,
      [workspaceId, groupId, userId, role],
    );
    const row = r.rows[0];
    return { ...row, membership_id: null, display_name: null } as GroupMemberRow;
  });
}

/** 移除群組成員。回被刪 id 或 null。 */
export async function removeGroupMember(
  workspaceId: string,
  groupId: string,
  userId: string,
): Promise<string | null> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `DELETE FROM group_members WHERE group_id=$1 AND user_id=$2 RETURNING id`,
      [groupId, userId],
    );
    return r.rows[0]?.id ?? null;
  });
}

/**
 * 解析「某 membership 是哪些群組的 leader」→ 回其可代排的 member membership_id 集合
 * （Req 1.3：leader 可讀其 member 的 availability）。
 * 給定 leader 的 membership_id，回同群組其他成員（含自己）的 membership_id。
 */
export async function membersLedByLeader(
  workspaceId: string,
  leaderMembershipId: string,
): Promise<string[]> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `WITH leader_user AS (
         SELECT user_id FROM memberships WHERE id = $1
       ),
       led_groups AS (
         SELECT gm.group_id FROM group_members gm
         JOIN leader_user lu ON lu.user_id = gm.user_id
         WHERE gm.role = 'leader'
       )
       SELECT DISTINCT m.id AS membership_id
         FROM group_members gm
         JOIN led_groups lg ON lg.group_id = gm.group_id
         JOIN memberships m ON m.user_id = gm.user_id AND m.workspace_id = gm.workspace_id`,
      [leaderMembershipId],
    );
    return r.rows.map((row) => row.membership_id as string);
  });
}

/**
 * 解析群組（依名稱關鍵字 or「我的組員/團隊」代名詞）→ 該 leader 所領群組全體 membership_id。
 * 供 Coordinator 把模糊代名詞解析為真實成員（Req 2.1）。
 * - groupNameHint：若提供，先以名稱模糊比對群組；否則取 requester 所領的所有群組。
 */
export async function resolveTeamMemberships(
  workspaceId: string,
  requesterMembershipId: string,
  groupNameHint?: string,
): Promise<string[]> {
  return withWorkspace(workspaceId, async (c) => {
    if (groupNameHint) {
      const r = await c.query(
        `SELECT DISTINCT m.id AS membership_id
           FROM groups g
           JOIN group_members gm ON gm.group_id = g.id
           JOIN memberships m ON m.user_id = gm.user_id AND m.workspace_id = gm.workspace_id
          WHERE g.name ILIKE '%' || $1 || '%'`,
        [groupNameHint],
      );
      if (r.rows.length > 0) return r.rows.map((row) => row.membership_id as string);
    }
    // fallback：requester 所領群組（leader）的全體成員
    const r2 = await c.query(
      `WITH requester_user AS (
         SELECT user_id FROM memberships WHERE id = $1
       ),
       led_groups AS (
         SELECT gm.group_id FROM group_members gm
         JOIN requester_user ru ON ru.user_id = gm.user_id
         WHERE gm.role = 'leader'
       )
       SELECT DISTINCT m.id AS membership_id
         FROM group_members gm
         JOIN led_groups lg ON lg.group_id = gm.group_id
         JOIN memberships m ON m.user_id = gm.user_id AND m.workspace_id = gm.workspace_id`,
      [requesterMembershipId],
    );
    return r2.rows.map((row) => row.membership_id as string);
  });
}
