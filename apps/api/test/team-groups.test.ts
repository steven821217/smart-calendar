import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import type { z } from "zod";
import { buildServer } from "../src/server.js";
import { signJwt } from "../src/auth/jwt.js";
import type { AuthContext } from "../src/auth/jwt.js";
import type { ChatModel, ChatMessage } from "../src/agents/llm.js";
import { toolDelegateComplexScheduling } from "../src/mcp/tools.js";

/**
 * feature-team-groups 整合測試：
 * Leader 叫 Agent 幫團隊排會 → 委員會解析出團隊 Members 產生 pending 邀請
 * → Member 用 rsvp_token 呼叫 POST /v1/events/:id/rsvp 同意/拒絕，事件正式排入。
 * 另含群組 REST 授權與 RSVP token 安全性。
 */

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

const app = buildServer();

let WS: string, CAL: string;
let LEADER_MEM: string; // leader 的 membership_id（= committee ctx.sub）
let M1: string, M2: string, M3: string; // 三位 member 的 membership_id
let VEHICLE: string;
const GROUP_NAME = "Alpha 小隊";

async function mkUserMembership(admin: pg.Client, email: string, name: string, ws: string) {
  const uid = (
    await admin.query(
      `INSERT INTO users(email,display_name) VALUES($1,$2)
       ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
      [email, name],
    )
  ).rows[0].id;
  const mid = (
    await admin.query(
      `INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member')
       ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='member' RETURNING id`,
      [ws, uid],
    )
  ).rows[0].id;
  return { uid, mid };
}

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  CAL = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS])).rows[0].id;

  // leader = seed 的 ws-a admin membership（也是 committee ctx.sub）
  const leader = await mkUserMembership(admin, "leader-team@example.com", "Team Leader", WS);
  LEADER_MEM = leader.mid;
  const a = await mkUserMembership(admin, "team-a@example.com", "Team Alice", WS);
  const b = await mkUserMembership(admin, "team-b@example.com", "Team Bob", WS);
  const cM = await mkUserMembership(admin, "team-c@example.com", "Team Carol", WS);
  M1 = a.mid;
  M2 = b.mid;
  M3 = cM.mid;

  // 乾淨群組：以 admin 直建，避免耦合 REST（REST 授權另有專測）
  await admin.query(`DELETE FROM groups WHERE workspace_id=$1 AND name=$2`, [WS, GROUP_NAME]);
  const g = (
    await admin.query(`INSERT INTO groups(workspace_id,name,created_by) VALUES($1,$2,$3) RETURNING id`, [WS, GROUP_NAME, LEADER_MEM])
  ).rows[0].id;
  await admin.query(
    `INSERT INTO group_members(workspace_id,group_id,user_id,role) VALUES
       ($1,$2,$3,'leader'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'member')`,
    [WS, g, leader.uid, a.uid, b.uid, cM.uid],
  );

  // 乾淨公務車起點
  await admin.query(`DELETE FROM resource_bookings WHERE workspace_id=$1`, [WS]);
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE '%TeamVehicle%'`, [WS]);
  await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND start_utc >= '2028-01-01'`, [WS]);
  VEHICLE = (
    await admin.query(
      `INSERT INTO resources(workspace_id,name,type) VALUES($1,'TeamVehicle-公務車','equipment') RETURNING id`,
      [WS],
    )
  ).rows[0].id;
  await admin.end();
  await app.ready();
});

const leaderAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
  sub: LEADER_MEM,
  workspace: WS,
  roles: ["scheduler"],
  scope: ["availability.read", "event.write", "resource.book"],
  ...over,
});

/** stub 模型：Coordinator 抽不到明確 attendee（交給團隊代名詞解析）+ 公務車需求。 */
function teamVehicleModel(): ChatModel {
  return {
    async invokeStructured<T>(_schema: z.ZodType<T>, _messages: ChatMessage[]): Promise<T> {
      return { attendee_ids: [], unresolved_names: [], resources: [{ kind: "vehicle" }] } as T;
    },
  };
}

const leaderTok = () => signJwt({ sub: LEADER_MEM, workspace: WS, roles: ["scheduler"] });
const memberTok = () => signJwt({ sub: M1, workspace: WS, roles: ["member"] });

describe("Team Groups REST 授權", () => {
  it("member 建群組 → 403；scheduler → 201；member 可讀", async () => {
    const denied = await app.inject({
      method: "POST", url: "/v1/groups",
      headers: { authorization: `Bearer ${memberTok()}` },
      payload: { name: "MemberDeniedGroup" },
    });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST", url: "/v1/groups",
      headers: { authorization: `Bearer ${leaderTok()}` },
      payload: { name: "SchedulerGroup" },
    });
    expect(created.statusCode).toBe(201);
    const gid = created.json().id;

    const list = await app.inject({
      method: "GET", url: "/v1/groups",
      headers: { authorization: `Bearer ${memberTok()}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().groups.some((g: { id: string }) => g.id === gid)).toBe(true);

    // 清理
    await app.inject({
      method: "DELETE", url: `/v1/groups/${gid}`,
      headers: { authorization: `Bearer ${leaderTok()}` },
    });
  });
});

describe("Team delegation 閉環 (feature-team-groups Deliverable 4)", () => {
  let eventId: string;
  let invitations: Array<{ member_id: string; event_id: string; rsvp_token: string }>;

  it("Leader 叫 Agent 幫團隊排會 → 3 個 Member 產生 pending 邀請", async () => {
    const res = await toolDelegateComplexScheduling(
      leaderAuth(),
      {
        task_description: "幫我的團隊借一輛公務車去客戶場勘，2028-03-01 下午 2 點，1 小時",
        reference_now_utc: "2026-09-15T00:00:00Z",
        default_timezone: "UTC",
        confirm: true,
        calendar_id: CAL,
        title: "團隊客戶場勘",
      },
      { model: teamVehicleModel() },
    );

    expect(res.status).toBe("booked");
    const result = res.result as {
      event: { id: string; source: string };
      rsvp_invitations: Array<{ member_id: string; event_id: string; rsvp_token: string }>;
    };
    eventId = result.event.id;
    invitations = result.rsvp_invitations;

    // 3 位 member 收到 pending 邀請（leader 自己不算被委派）
    expect(invitations.length).toBe(3);
    const invitedMembers = invitations.map((i) => i.member_id).sort();
    expect(invitedMembers).toEqual([M1, M2, M3].sort());
    invitations.forEach((i) => {
      expect(i.event_id).toBe(eventId);
      expect(typeof i.rsvp_token).toBe("string");
      expect(i.rsvp_token.length).toBeGreaterThan(10);
    });

    // DB：3 位 member 皆為 pending
    const admin = adminClient();
    await admin.connect();
    const parts = await admin.query(
      `SELECT member_id, rsvp_status FROM event_participants WHERE workspace_id=$1 AND event_id=$2`,
      [WS, eventId],
    );
    await admin.end();
    const byMember = Object.fromEntries(parts.rows.map((p) => [p.member_id, p.rsvp_status]));
    expect(byMember[M1]).toBe("pending");
    expect(byMember[M2]).toBe("pending");
    expect(byMember[M3]).toBe("pending");
  });

  it("Member 用 rsvp_token accept → 正式排入 (accepted)", async () => {
    const inv = invitations.find((i) => i.member_id === M1)!;
    const res = await app.inject({
      method: "POST", url: `/v1/events/${eventId}/rsvp`,
      payload: { option_token: inv.rsvp_token, decision: "accept" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rsvp_status).toBe("accepted");

    const admin = adminClient();
    await admin.connect();
    const st = await admin.query(
      `SELECT rsvp_status FROM event_participants WHERE workspace_id=$1 AND event_id=$2 AND member_id=$3`,
      [WS, eventId, M1],
    );
    await admin.end();
    expect(st.rows[0].rsvp_status).toBe("accepted");
  });

  it("Member 用 rsvp_token decline → declined", async () => {
    const inv = invitations.find((i) => i.member_id === M2)!;
    const res = await app.inject({
      method: "POST", url: `/v1/events/${eventId}/rsvp`,
      payload: { option_token: inv.rsvp_token, decision: "decline" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rsvp_status).toBe("declined");
  });

  it("RSVP 免登入 JWT（token 自證身份），但 token event 綁定：改路徑 id → 403", async () => {
    const inv = invitations.find((i) => i.member_id === M3)!;
    const res = await app.inject({
      method: "POST", url: `/v1/events/00000000-0000-0000-0000-000000000000/rsvp`,
      payload: { option_token: inv.rsvp_token, decision: "accept" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("竄改 / 無效 rsvp_token → 401", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/events/${eventId}/rsvp`,
      payload: { option_token: "not.a.valid.token", decision: "accept" },
    });
    expect(res.statusCode).toBe(401);
  });
});
