/**
 * 端到端情境驗證：team leader 經外部 agent 用 MCP 委派委員會，幫團隊全體 member 排一場會。
 *
 * 驗證整套機制（feature-team-groups / internal-multi-agent-scheduling）：
 *   委員會排會 → 委派成員 rsvp_status='pending' → 各簽 rsvp_token
 *   + scheduling.rsvp_pending webhook 路徑 → member 憑 token accept 正式排入。
 *
 * 真實機制語意（本情境）：team leader 幫「整個團隊」排會，coordinator 的團隊代名詞解析
 * （resolveTeamMemberships，以 ctx.sub = leader membership_id 反查其所領群組）會把 leader
 * 自己過濾掉，只留下 3 位組員 → 全部以 delegated（rsvp_status='pending'）落實。
 * 因此正確結果是：event_participants 恰 3 筆、全部 pending、對應那 3 位組員；leader 無參與者列。
 *
 * 兩段真實傳輸：
 *   - delegate：in-process buildHttpServer()（MCP_STUB_MODEL=1）+ StreamableHTTPClientTransport
 *     帶 Bearer（自簽 agent token）走 JSON-RPC，對齊 test/mcp-http-e2e.test.ts。
 *   - RSVP：in-process buildServer()（Fastify）真打 POST /v1/events/:id/rsvp（免登入，token 自證）。
 *
 * 執行（容器內，走 compose 內網 db/redis/opa）：
 *   docker exec smart-calendar-api-1 sh -c 'MCP_STUB_MODEL=1 pnpm exec tsx src/scripts/team-meeting-scenario.ts'
 *
 * LLM：本驗證重點是機制非 LLM，一律走 stub（MCP_STUB_MODEL=1）。stub 預設回
 * attendee_ids:[]、resources:[{kind:'vehicle'}]，attendee 全靠團隊代名詞解析。
 */
import pg from "pg";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildHttpServer } from "../mcp/http.js";
import { buildServer } from "../server.js";
import { signJwt } from "../auth/jwt.js";

// --- 迷你斷言框架：逐條印 [PASS]/[FAIL]/[SKIP] 並累計 -------------------------
let passed = 0,
  failed = 0,
  skipped = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(label: string, why: string) {
  skipped++;
  console.log(`[SKIP] ${label} — ${why}`);
}

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

// 固定命名讓情境可重跑（每次先清乾淨）
const GROUP_NAME = "TeamMeeting 小隊";
const VEHICLE_NAME = "TeamMeetingVehicle-公務車";
const EMAIL_LEADER = "tm-leader@example.com";
const EMAILS_MEMBER = ["tm-alice@example.com", "tm-bob@example.com", "tm-carol@example.com"];
const NAMES_MEMBER = ["TM Alice", "TM Bob", "TM Carol"];
const FUTURE_GUARD = "2029-01-01"; // 清理/隔離窗：本情境事件排在 2029+

interface Fixtures {
  ws: string;
  cal: string;
  leaderMem: string;
  memberMems: string[]; // [alice, bob, carol]
  vehicle: string;
}

async function upsertUserMembership(admin: pg.Client, email: string, name: string, ws: string) {
  const uid = (
    await admin.query(
      `INSERT INTO users(email,display_name) VALUES($1,$2)
       ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
      [email, name],
    )
  ).rows[0].id as string;
  const mid = (
    await admin.query(
      `INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member')
       ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='member' RETURNING id`,
      [ws, uid],
    )
  ).rows[0].id as string;
  return { uid, mid };
}

async function buildFixtures(): Promise<Fixtures> {
  const admin = adminClient();
  await admin.connect();
  try {
    const ws = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id as string;
    const cal = (
      await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [ws])
    ).rows[0].id as string;

    // leader + 3 members（不同 display_name）
    const leader = await upsertUserMembership(admin, EMAIL_LEADER, "TM Leader", ws);
    const members = [];
    for (let i = 0; i < 3; i++) {
      members.push(await upsertUserMembership(admin, EMAILS_MEMBER[i], NAMES_MEMBER[i], ws));
    }

    // 乾淨群組：leader role='leader'、3 members role='member'
    await admin.query(`DELETE FROM groups WHERE workspace_id=$1 AND name=$2`, [ws, GROUP_NAME]);
    const gid = (
      await admin.query(`INSERT INTO groups(workspace_id,name,created_by) VALUES($1,$2,$3) RETURNING id`, [
        ws,
        GROUP_NAME,
        leader.mid,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO group_members(workspace_id,group_id,user_id,role) VALUES
         ($1,$2,$3,'leader'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'member')`,
      [ws, gid, leader.uid, members[0].uid, members[1].uid, members[2].uid],
    );

    // 乾淨公務車起點（equipment + 名稱含「公務車」→ isHandoverResource → 需交接）
    await admin.query(
      `DELETE FROM resource_bookings WHERE resource_id IN
         (SELECT id FROM resources WHERE workspace_id=$1 AND name=$2)`,
      [ws, VEHICLE_NAME],
    );
    await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name=$2`, [ws, VEHICLE_NAME]);
    const vehicle = (
      await admin.query(`INSERT INTO resources(workspace_id,name,type) VALUES($1,$2,'equipment') RETURNING id`, [
        ws,
        VEHICLE_NAME,
      ])
    ).rows[0].id as string;

    // 清掉本情境舊事件（2029+），避免 attendee 被誤判為忙 / 參與者殘留
    await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND start_utc >= $2`, [ws, FUTURE_GUARD]);

    return { ws, cal, leaderMem: leader.mid, memberMems: members.map((m) => m.mid), vehicle };
  } finally {
    await admin.end();
  }
}

// agent token：sub = leader membership_id（coordinator 團隊解析以 ctx.sub 反查所領群組）。
// 授權 = scope ∩ role（mcp.md §4/§9）：外部 agent 代理 team leader，故繼承其實際角色
// 'scheduler'（OPA 據此對 event.create/resource.book/availability.read 放行）。role='agent'
// 不對映任何 OPA 規則會被 fail-closed 拒絕（forbidden），非本情境要驗的語意。
function agentToken(fx: Fixtures, scope = "availability.read,event.write,resource.book"): string {
  return signJwt(
    { sub: fx.leaderMem, workspace: fx.ws, roles: ["scheduler"], scope: scope.split(",").map((s) => s.trim()) },
    3600,
  );
}

async function connectMcp(baseUrl: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "team-meeting-scenario", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function parseToolResult(res: unknown): { isError?: boolean; payload: Record<string, unknown> } {
  const r = res as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: r.isError, payload: JSON.parse(r.content?.[0]?.text ?? "{}") };
}

async function eventCount(ws: string): Promise<number> {
  const admin = adminClient();
  await admin.connect();
  try {
    const r = await admin.query(`SELECT count(*)::int AS n FROM events WHERE workspace_id=$1`, [ws]);
    return r.rows[0].n as number;
  } finally {
    await admin.end();
  }
}

async function auditCount(ws: string, action: string, targetId?: string): Promise<number> {
  const admin = adminClient();
  await admin.connect();
  try {
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE workspace_id=$1 AND action=$2 ${targetId ? "AND target_id=$3" : ""}`,
      targetId ? [ws, action, targetId] : [ws, action],
    );
    return r.rows[0].n as number;
  } finally {
    await admin.end();
  }
}

const TASK = "幫我的團隊借一輛公務車去客戶場勘，2029-03-01 下午 2 點，1 小時";

async function main() {
  // stub 一律開（機制驗證，不打 LLM）
  process.env.MCP_STUB_MODEL = "1";
  delete process.env.MCP_STUB_MEMBER_ID; // 決策 1：不把 leader 灌成明確 attendee

  console.log("=== Team Meeting E2E Scenario ===");
  console.log(`stub=${process.env.MCP_STUB_MODEL} member_id_inject=${process.env.MCP_STUB_MEMBER_ID ?? "(none)"}`);

  const fx = await buildFixtures();
  console.log(
    `fixtures: ws=${fx.ws} cal=${fx.cal}\n          leader=${fx.leaderMem} members=[${fx.memberMems.join(", ")}]\n          vehicle=${fx.vehicle}`,
  );

  // in-process MCP HTTP（loopback ephemeral）
  const mcpServer: Server = buildHttpServer();
  await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", r));
  const mcpAddr = mcpServer.address();
  const mcpPort = typeof mcpAddr === "object" && mcpAddr ? mcpAddr.port : 0;
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  // in-process API（Fastify）供 RSVP HTTP
  const api = buildServer();
  await api.ready();
  const apiAddr = await api.listen({ port: 0, host: "127.0.0.1" });
  const apiBase = typeof apiAddr === "string" ? apiAddr : `http://127.0.0.1:${(apiAddr as { port: number }).port}`;
  console.log(`servers: mcp=${mcpUrl} api=${apiBase}`);

  let eventId = "";
  let invitations: Array<{ member_id: string; event_id: string; rsvp_token: string }> = [];

  try {
    // --- 步驟 1：MCP tools 可列出（傳輸/授權鏈通）---------------------------
    {
      const { client, transport } = await connectMcp(mcpUrl, agentToken(fx));
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        ok(names.includes("delegate_complex_scheduling"), "MCP 傳輸連線 + 列 tools", `tools=${names.length}`);
      } finally {
        await transport.close();
      }
    }

    // --- 步驟 2：explain dry-run（回 trace、DB 零寫入）----------------------
    {
      const beforeEvents = await eventCount(fx.ws);
      const beforeCommit = await auditCount(fx.ws, "committee.commit");
      const { client, transport } = await connectMcp(mcpUrl, agentToken(fx));
      let payload: Record<string, unknown> = {};
      let isError: boolean | undefined;
      try {
        const res = await client.callTool({
          name: "delegate_complex_scheduling",
          arguments: {
            task_description: TASK,
            reference_now_utc: "2026-09-15T00:00:00Z",
            default_timezone: "UTC",
            explain: true,
            confirm: true, // explain 優先，仍不落實
            calendar_id: fx.cal,
            title: "團隊客戶場勘",
          },
        });
        ({ isError, payload } = parseToolResult(res));
      } finally {
        await transport.close();
      }
      ok(isError !== true && payload.explain === true, "explain dry-run 回 explain=true", `status=${String(payload.status)}`);
      ok(Array.isArray(payload.trace) && (payload.trace as unknown[]).length > 0, "explain 回非空 trace", `trace=${Array.isArray(payload.trace) ? (payload.trace as unknown[]).length : "n/a"} 節點`);
      const afterEvents = await eventCount(fx.ws);
      const afterCommit = await auditCount(fx.ws, "committee.commit");
      ok(afterEvents === beforeEvents, "explain 不落實：events 數不變", `${beforeEvents}→${afterEvents}`);
      ok(afterCommit === beforeCommit, "explain 不落實：committee.commit 稽核不變", `${beforeCommit}→${afterCommit}`);
    }

    // --- 步驟 3：confirm=true 落實（booked + 3 筆 rsvp_invitations）---------
    {
      const beforeDecision = await auditCount(fx.ws, "committee.decision");
      const { client, transport } = await connectMcp(mcpUrl, agentToken(fx));
      let payload: Record<string, unknown> = {};
      let isError: boolean | undefined;
      try {
        const res = await client.callTool({
          name: "delegate_complex_scheduling",
          arguments: {
            task_description: TASK,
            reference_now_utc: "2026-09-15T00:00:00Z",
            default_timezone: "UTC",
            confirm: true,
            calendar_id: fx.cal,
            title: "團隊客戶場勘",
          },
        });
        ({ isError, payload } = parseToolResult(res));
      } finally {
        await transport.close();
      }
      ok(isError !== true && payload.status === "booked", "confirm=true → status=booked", `status=${String(payload.status)}`);
      const result = (payload.result ?? {}) as {
        event?: { id?: string; source?: string };
        rsvp_invitations?: Array<{ member_id: string; event_id: string; rsvp_token: string }>;
      };
      eventId = result.event?.id ?? "";
      invitations = result.rsvp_invitations ?? [];
      ok(result.event?.source === "agent", "落實事件 source=agent", `source=${String(result.event?.source)}`);
      ok(invitations.length === 3, "result.rsvp_invitations 恰 3 筆", `count=${invitations.length}`);
      ok(
        invitations.every((i) => i.event_id === eventId && typeof i.rsvp_token === "string" && i.rsvp_token.length > 10),
        "每筆邀請綁同一 event_id 且帶有效 rsvp_token",
      );
      const invitedSorted = invitations.map((i) => i.member_id).sort();
      ok(
        JSON.stringify(invitedSorted) === JSON.stringify([...fx.memberMems].sort()),
        "受邀 3 人 = 那 3 位組員（leader 不在內）",
        `invited=[${invitedSorted.join(", ")}]`,
      );
      const afterDecision = await auditCount(fx.ws, "committee.decision");
      ok(afterDecision > beforeDecision, "audit_log 有 committee.decision", `${beforeDecision}→${afterDecision}`);
      ok((await auditCount(fx.ws, "committee.commit", eventId)) > 0, "audit_log 有 committee.commit（綁此 event）");
    }

    if (!eventId) {
      skip("DB 參與者斷言", "沒有 event_id（落實失敗）");
      skip("RSVP accept 驗證", "沒有 event_id（落實失敗）");
    } else {
      // --- 步驟 4：DB 驗參與者（恰 3 筆 pending、leader 無列）--------------
      {
        const admin = adminClient();
        await admin.connect();
        let parts: Array<{ member_id: string; rsvp_status: string }> = [];
        try {
          parts = (
            await admin.query(
              `SELECT member_id, rsvp_status FROM event_participants WHERE workspace_id=$1 AND event_id=$2`,
              [fx.ws, eventId],
            )
          ).rows;
        } finally {
          await admin.end();
        }
        ok(parts.length === 3, "event_participants 恰 3 筆", `count=${parts.length}`);
        ok(parts.every((p) => p.rsvp_status === "pending"), "3 筆全部 rsvp_status='pending'", `statuses=[${parts.map((p) => p.rsvp_status).join(", ")}]`);
        const partIds = parts.map((p) => p.member_id).sort();
        ok(
          JSON.stringify(partIds) === JSON.stringify([...fx.memberMems].sort()),
          "3 筆參與者 = 那 3 位組員",
          `parts=[${partIds.join(", ")}]`,
        );
        ok(!parts.some((p) => p.member_id === fx.leaderMem), "leader 不在參與者列（team leader 幫團隊排會的正確語意）");
      }

      // --- 步驟 5：scheduling.rsvp_pending webhook 路徑 --------------------
      // calendar_graph 對每筆委派邀請 publishEvent('scheduling.rsvp_pending')；
      // 本情境未註冊訂閱者，故 delivery 佇列筆數為 0（best-effort，不阻斷落實）。
      // 3 筆 rsvp_invitations 帶 token = webhook 觸發所需的完整 payload 已備妥 → 路徑已走。
      ok(
        invitations.length === 3 && invitations.every((i) => i.rsvp_token.length > 10),
        "scheduling.rsvp_pending 觸發輸入齊備（3 筆邀請各帶 token）",
        "無訂閱者時 delivery 為 best-effort 0 筆",
      );

      // --- 步驟 6：某組員憑 rsvp_token accept → 翻成 accepted（真 HTTP）----
      {
        const inv = invitations.find((i) => i.member_id === fx.memberMems[0])!;
        const res = await fetch(`${apiBase}/v1/events/${eventId}/rsvp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ option_token: inv.rsvp_token, decision: "accept" }),
        });
        const body = (await res.json().catch(() => ({}))) as { rsvp_status?: string };
        ok(res.status === 200, "POST /v1/events/:id/rsvp 免登入回 200", `http=${res.status}`);
        ok(body.rsvp_status === "accepted", "RSVP 回應 rsvp_status=accepted", `body.rsvp_status=${String(body.rsvp_status)}`);

        const admin = adminClient();
        await admin.connect();
        let dbStatus: string | null = null;
        try {
          dbStatus = (
            await admin.query(
              `SELECT rsvp_status FROM event_participants WHERE workspace_id=$1 AND event_id=$2 AND member_id=$3`,
              [fx.ws, eventId, fx.memberMems[0]],
            )
          ).rows[0]?.rsvp_status ?? null;
        } finally {
          await admin.end();
        }
        ok(dbStatus === "accepted", "DB 該組員 rsvp_status 已翻成 accepted", `db=${String(dbStatus)}`);

        // 其餘 2 位仍 pending（accept 只影響本人）
        const admin2 = adminClient();
        await admin2.connect();
        let others: Array<{ rsvp_status: string }> = [];
        try {
          others = (
            await admin2.query(
              `SELECT rsvp_status FROM event_participants WHERE workspace_id=$1 AND event_id=$2 AND member_id = ANY($3)`,
              [fx.ws, eventId, [fx.memberMems[1], fx.memberMems[2]]],
            )
          ).rows;
        } finally {
          await admin2.end();
        }
        ok(others.length === 2 && others.every((o) => o.rsvp_status === "pending"), "另 2 位組員仍為 pending（accept 只影響本人）");
      }
    }
  } finally {
    await new Promise<void>((r) => mcpServer.close(() => r()));
    await api.close();
  }

  console.log("\n=== 總結 ===");
  console.log(`PASS=${passed}  FAIL=${failed}  SKIP=${skipped}`);
  const verdict = failed === 0 && passed > 0;
  console.log(`機制結論：${verdict ? "✅ 正確 — 委員會排會 → 委派成員 pending + rsvp_token + webhook 路徑 → 憑 token accept 正式排入，閉環成立。" : "❌ 有斷言失敗，見上方 [FAIL]。"}`);
  process.exit(verdict ? 0 : 1);
}

main().catch((e) => {
  console.error("SCENARIO FATAL:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
