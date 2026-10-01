/**
 * MCP Server（stdio）— 對外暴露日曆能力給 AI Agent（mcp.md §1/§6）。
 *
 * 定位：本機/桌面 agent 走 stdio（mcp.md §6）。每個 tool = 一個 PEP，
 * 複用與 REST 相同的授權鏈（guardTool → PDP(OPA) → RLS）。此檔只負責
 * 「MCP 協定 ⇄ 既有 tool handler」的轉接，不新增旁路（ZT-3）。
 *
 * 授權（本機 dev 模式）：
 *  - OAuth 2.1 consent 流程列為未實作（mcp.md §3 / 8.3）。本機測試以既有 signJwt
 *    自簽一組帶 scope 的 M2M dev token，透過 MCP_DEV_* 環境變數配置 workspace/scope。
 *  - workspace/sub 僅來自此憑證，tool 參數不得帶 workspace_id（ZT-5 / MCP-3）。
 *
 * 執行：
 *   MCP_DEV_WORKSPACE=<ws-id> MCP_DEV_SUB=<membership-id> \
 *   MCP_DEV_SCOPE="availability.read,event.write,resource.book" \
 *   tsx src/mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { verifyJwt, signJwt, type AuthContext } from "../auth/jwt.js";
import { McpAuthError, guardTool } from "./guard.js";
import {
  toolFindAvailability,
  toolCreateSmartEvent,
  toolBookResource,
  toolListOccurrences,
  toolParseEventFromText,
  toolDelegateComplexScheduling,
} from "./tools.js";
import type { ChatModel, ChatMessage } from "../agents/llm.js";
import { makeChatModel } from "../agents/llm.js";
import { runInAppAgent, type DecisionNote } from "../agents/inapp/service.js";
import { shapeForExternalAgent, type DetailLevel } from "./external-view.js";
import { ExternalPlanSchema, routeFromExternalPlan, type ExternalPlan } from "./external-plan.js";
import type { RouteResult } from "../agents/inapp/router.js";
import { buildServerCard } from "./server-card.js";
import { assessLocalCompetence, escalationOperatorCatalogue } from "./collaboration.js";
import { gatherFactsForEscalation } from "./escalation-facts.js";

/**
 * 解析本機 dev 授權：優先用 MCP_DEV_TOKEN（完整 Bearer JWT）；
 * 否則以 MCP_DEV_WORKSPACE / MCP_DEV_SUB / MCP_DEV_SCOPE 自簽一組短效 M2M token。
 * 回傳 AuthContext（供 handler 使用）與可讀來源描述。
 */
export function resolveDevAuth(env: NodeJS.ProcessEnv = process.env): {
  auth: AuthContext | null;
  source: string;
} {
  if (env.MCP_DEV_TOKEN) {
    return { auth: verifyJwt(`Bearer ${env.MCP_DEV_TOKEN}`), source: "MCP_DEV_TOKEN" };
  }
  const workspace = env.MCP_DEV_WORKSPACE;
  const sub = env.MCP_DEV_SUB;
  if (!workspace || !sub) return { auth: null, source: "unconfigured" };
  const scope = (env.MCP_DEV_SCOPE ?? "availability.read,event.write,resource.book")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const roles = (env.MCP_DEV_ROLES ?? "scheduler")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const token = signJwt({ sub, workspace, roles, scope }, 3600);
  return { auth: verifyJwt(`Bearer ${token}`), source: "MCP_DEV_* self-signed" };
}

/**
 * dev stub 模型：讓沒有 OPENAI_API_KEY 的環境也能端到端跑 delegate_complex_scheduling。
 * 僅在 MCP_STUB_MODEL=1 時啟用；解析出「借公務車」情境的固定實體，時間仍走真實 parser。
 * 生產環境切勿開啟（會忽略真正的 NL 解析）。
 */
function makeStubModel(): ChatModel {
  const stubMember = process.env.MCP_STUB_MEMBER_ID;
  return {
    async invokeStructured<T>(_schema: z.ZodType<T>, _messages: ChatMessage[]): Promise<T> {
      return {
        attendee_ids: stubMember ? [stubMember] : [],
        unresolved_names: [],
        resources: [{ kind: "vehicle" }],
      } as T;
    },
  };
}

/** MCP 錯誤 → 結構化 tool result（isError），保留 kind 讓用戶端可判讀。 */
function errorResult(e: unknown) {
  if (e instanceof McpAuthError) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: JSON.stringify({ error: e.kind, message: e.message }) }],
    };
  }
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: JSON.stringify({ error: "internal", message: e instanceof Error ? e.message : String(e) }) },
    ],
  };
}

function okResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * 解析「代表誰操作」的可讀身分（whoami 用）。走 withWorkspace → RLS 兜底，
 * 只可能讀到本 workspace 的成員；查不到回 null（不拋，讓 whoami 仍能回 token 事實）。
 */
async function resolveIdentity(
  workspace: string,
  membershipId: string,
): Promise<
  | {
      membership_id: string;
      display_name: string | null;
      email: string | null;
      role: string;
      timezone: string;
      workspace: { slug: string; name: string };
    }
  | null
> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(membershipId)) return null;
  try {
    const { withWorkspace } = await import("../db/pool.js");
    return await withWorkspace(workspace, async (c) => {
      const r = await c.query(
        `SELECT m.id AS membership_id, m.role, m.timezone,
                u.display_name, u.email, w.slug, w.name
           FROM memberships m
           JOIN workspaces w ON w.id = m.workspace_id
           JOIN users u ON u.id = m.user_id
          WHERE m.id = $1 AND m.workspace_id = $2
          LIMIT 1`,
        [membershipId, workspace],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        membership_id: row.membership_id,
        display_name: row.display_name,
        email: row.email,
        role: row.role,
        timezone: row.timezone,
        workspace: { slug: row.slug, name: row.name },
      };
    });
  } catch {
    return null;
  }
}

export function buildMcpServer(auth: AuthContext | null): McpServer {
  const server = new McpServer({ name: "scal-calendar-mcp", version: "0.1.0" });
  const stubOpts = process.env.MCP_STUB_MODEL === "1" ? { model: makeStubModel() } : {};

  // Tool 1: find_available_time_slots（唯讀，availability.read）
  server.tool(
    "find_available_time_slots",
    "找共同空檔時段（唯讀；外部 agent 僅回 free/busy 等級資訊）",
    {
      from_utc: z.string().describe("UTC ISO-8601"),
      to_utc: z.string().describe("UTC ISO-8601"),
      duration_minutes: z.number().int().positive(),
      busy: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
      max_results: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        return okResult(await toolFindAvailability(auth, args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Tool 2: create_smart_event（寫，event.create）
  server.tool(
    "create_smart_event",
    "建立事件（自動衝突檢查；source=agent）",
    {
      calendar_id: z.string(),
      title: z.string().min(1).max(300),
      start_utc: z.string(),
      end_utc: z.string(),
      timezone: z.string().describe("IANA"),
      rrule: z.string().optional().describe("RFC 5545；省略=單次"),
    },
    async (args) => {
      try {
        return okResult(await toolCreateSmartEvent(auth, args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Tool 5: book_resource（寫，resource.book；require_confirmation）
  server.tool(
    "book_resource",
    "預訂資源（防雙訂；未帶 confirm=true 回 confirmation_required，不落實）",
    {
      resource_id: z.string(),
      event_id: z.string(),
      start_utc: z.string(),
      end_utc: z.string(),
      confirm: z.boolean().optional(),
    },
    async (args) => {
      try {
        return okResult(await toolBookResource(auth, args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Tool 6: parse_event_from_text（唯讀草稿，event.write scope）
  server.tool(
    "parse_event_from_text",
    "自然語言 → 事件草稿（不落 DB）",
    {
      text: z.string(),
      reference_now_utc: z.string().optional(),
      default_timezone: z.string(),
    },
    async (args) => {
      try {
        return okResult(await toolParseEventFromText(auth, args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Tool 7: list_event_occurrences（唯讀，availability.read）
  server.tool(
    "list_event_occurrences",
    "展開時間窗口內的 occurrences",
    {
      from_utc: z.string(),
      to_utc: z.string(),
    },
    async (args) => {
      try {
        return okResult(await toolListOccurrences(auth, args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 高階委派：delegate_complex_scheduling（internal-multi-agent-scheduling / mcp-api.md）
  server.tool(
    "delegate_complex_scheduling",
    "高階委派：描述複雜排程任務，內部委員會（LangGraph）完成排程/談判",
    {
      task_description: z.string(),
      reference_now_utc: z.string().optional(),
      default_timezone: z.string().optional(),
      confirm: z.boolean().optional(),
      explain: z.boolean().optional(),
      calendar_id: z.string().optional(),
      title: z.string().optional(),
      option_token: z.string().optional(),
    },
    async (args) => {
      try {
        return okResult(await toolDelegateComplexScheduling(auth, args, stubOpts));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Tool 7: 日曆查詢（唯讀，event.read）。
  // 兩個名稱共用同一實作：
  //   calendar_query  ── namespace 化的正名（Microsoft Research 2025 建議正式命名空間，
  //                      其調查中 775 個工具撞名、`search` 一名重複 32 次）
  //   query_calendar  ── 既有名稱，保留相容，description 標示 deprecated
  const CALENDAR_QUERY_INPUT = {
    question: z.string().min(1).max(1000).optional().describe("自然語言問題，如「明天下午有哪些會」"),
    subtasks: z
      .array(z.string().min(1).max(300))
      .min(2)
      .max(5)
      .optional()
      .describe("呼叫端已自行拆好的獨立子請求；給了就跳過本地 Planner（省一次模型呼叫與其誤判風險）"),
    plan: ExternalPlanSchema.optional().describe(
      "呼叫端已自行理解好的查詢（intent + 槽位）；給了就完全不呼叫本地 14B，回應在數百毫秒內完成",
    ),
    detail: z
      .enum(["brief", "structured", "evidence", "auto"])
      .optional()
      .describe(
        "回應細節層級。brief=一句自然語言（預設，給能力有限的呼叫端）；" +
        "structured=結構化事實＋分頁；evidence=再加上決策依據與不確定性標記（建議強模型使用）",
      ),
    page: z.number().int().min(1).max(100).optional().describe("structured/evidence 的分頁頁碼"),
    page_size: z.number().int().min(1).max(50).optional().describe("每頁筆數，上限 50"),
    viewer_timezone: z.string().optional().describe("IANA 時區，預設 Asia/Taipei"),
  };

  const runCalendarQuery = async (args: {
    question?: string;
    subtasks?: string[];
    plan?: ExternalPlan;
    detail?: DetailLevel;
    page?: number;
    page_size?: number;
    viewer_timezone?: string;
  }) => {
    await guardTool(auth, "calendar_query", "event.read", { type: "event" });
    const detail: DetailLevel = args.detail ?? "brief";
    const tz = args.viewer_timezone ?? "Asia/Taipei";
    const model = stubOpts.model ?? makeChatModel();
    // M2M token 的 sub=agent_id；查詢「本人日曆」的本人是授權該 agent 的 user（user_sub）。
    const onBehalf = auth!.user_sub ?? auth!.sub;
    const queryAuth = { ...auth!, sub: onBehalf };
    const trace: DecisionNote[] = [];

    const inputCount = [args.question, args.subtasks, args.plan].filter((v) => v !== undefined).length;
    if (inputCount !== 1) {
      return okResult({
        kind: "invalid_request",
        message: "question、subtasks、plan 三者請恰好提供一個。",
        hint: "自然語言問題用 question；已自行拆解的多個請求用 subtasks；已自行理解好的查詢用 plan。",
      });
    }

    // 共用的執行 + 整形；readOnly 務必在 runInAppAgent **之內**就擋掉寫入類意圖
    // （舊實作先跑完才看 intent，respond_rsvp 已寫 DB 才回 not_permitted，回應與事實不符）。
    const execute = async (text: string, routeOverride?: RouteResult) =>
      runInAppAgent(queryAuth, text, tz, {
        model,
        readOnly: true,
        ...(routeOverride ? { routeOverride } : {}),
        ...(detail === "evidence" ? { trace } : {}),
      });

    // 協作模式（SWARM-LLM 式的 local-first cascade）：先做確定性能力自評。
    // 能力缺口與信心無關——本地再有信心也算不出「總共幾小時」，
    // 因此這類問題不必先跑一次模型才發現做不到，直接備好事實交給呼叫端推理。
    if (detail === "auto" && args.question) {
      const competence = assessLocalCompetence(args.question);
      if (!competence.competent) {
        const facts = await gatherFactsForEscalation(queryAuth, args.question, tz, new Date(), competence.operators.map((o) => o.id));
        return okResult({
          kind: "escalate",
          escalation: {
            reason: "local_capability_gap",
            operators: competence.operators,
            explanation: competence.reason,
            local_model: process.env.LLM_MODEL ?? "qwen3:14b",
          },
          // 附上事實，讓呼叫端一次就能完成推理，不必再往返
          facts,
          scope: {
            visibility: "requester_own_and_participating_events_only",
            excludes: "other_members_private_events",
          },
        });
      }
      // 本地有能力 → 本地實際跑一次（GPU 參與），再依執行過程的推測決定是否仍要升級
      const localReply = await execute(args.question);
      const uncertain = trace.filter((t) => t.uncertain);
      const flagsLocal = (localReply.data ?? {}) as { not_permitted?: boolean; not_a_query?: boolean };
      if (flagsLocal.not_permitted || flagsLocal.not_a_query) {
        return okResult({ kind: flagsLocal.not_a_query ? "not_a_query" : "not_permitted", message: localReply.message });
      }
      if (localReply.kind !== "answer" || uncertain.length > 0) {
        const facts = await gatherFactsForEscalation(queryAuth, args.question, tz);
        return okResult({
          kind: "escalate",
          escalation: {
            reason: localReply.kind !== "answer" ? "local_needs_clarification" : "local_uncertain_steps",
            uncertain_steps: uncertain.map((t) => ({ step: t.step, note: t.note })),
            explanation:
              "本地已嘗試回答，但過程中有推測步驟（候選重排／語法補抽）或無法確定目標；" +
              "附上事實供呼叫端自行判斷。",
            local_draft_answer: localReply.message,
          },
          facts,
          scope: {
            visibility: "requester_own_and_participating_events_only",
            excludes: "other_members_private_events",
          },
        });
      }
      return okResult({
        kind: "answer",
        intent: localReply.intent ?? null,
        message: localReply.message,
        handled_by: "local",
        // 讓呼叫端知道本地是走確定性路徑還是經過 14B
        local_route: localReply.via ?? null,
      });
    }

    let reply;
    if (args.plan) {
      // 外部 agent 已理解好 → 本地零模型呼叫，純資料執行
      const question = `[external-plan] ${args.plan.intent}`;
      reply = await execute(question, routeFromExternalPlan(args.plan, question));
      trace.push({
        step: "external_plan",
        note: "本次查詢的意圖與槽位由呼叫端提供，本地未呼叫語言模型",
        data: { plan: args.plan },
      });
    } else if (args.subtasks) {
      // 呼叫端已拆解 → 各子請求並行執行，跳過本地 Planner
      const parts = await Promise.all(args.subtasks.map((t) => execute(t)));
      const blocked = parts.find((r) => {
        const f = (r.data ?? {}) as { not_permitted?: boolean; not_a_query?: boolean };
        return f.not_permitted || f.not_a_query;
      });
      if (blocked) return okResult({ kind: "not_permitted", message: blocked.message });
      const shaped = parts.map((r, i) =>
        shapeForExternalAgent({ ...r, trace }, { detail, page: args.page, pageSize: args.page_size }),
      );
      return okResult({
        kind: parts.every((r) => r.kind === "answer") ? "answer" : "needs_clarification",
        intent: "multiple",
        subtask_results: args.subtasks.map((t, i) => ({ request: t, ...shaped[i] })),
        ...(detail === "brief"
          ? { message: parts.map((r, i) => `【${i + 1}】${r.message}`).join("\n\n") }
          : {}),
      });
    } else {
      reply = await execute(args.question!);
    }

    const flags = (reply.data ?? {}) as { not_a_query?: boolean; not_permitted?: boolean };
    // 查詢工具僅供查詢；排會請改用 delegate_complex_scheduling。
    if (flags.not_a_query || reply.intent === "schedule") {
      return okResult({ kind: "not_a_query", message: "這是排程需求，請改用 delegate_complex_scheduling 工具。" });
    }
    // 破壞性動作（改期/取消/回覆邀請）不開放外部 agent（唯讀邊界，ZT）。
    // 這裡是第二道防線；第一道在 runInAppAgent 的 readOnly。
    if (
      flags.not_permitted ||
      reply.intent === "reschedule" ||
      reply.intent === "cancel" ||
      reply.intent === "respond_rsvp"
    ) {
      return okResult({
        kind: "not_permitted",
        message: "查詢工具不支援修改行事曆（改期/取消/回覆邀請）；此類動作僅限使用者本人於站內操作。",
      });
    }
    // trace 陣列是我們自己傳進去的，因此即使 runInAppAgent 走了提早 return 的分支
    // （例如需要追問），決策紀錄仍在手上——不可依賴 reply.trace。
    return okResult(shapeForExternalAgent({ ...reply, trace }, { detail, page: args.page, pageSize: args.page_size }));
  };

  server.tool(
    "calendar_query",
    "查詢本人日曆（唯讀，僅本人的行程與本人受邀的共同行程）。" +
    "強模型建議帶 detail='evidence' 取得決策依據，或直接用 plan/subtasks 自行完成理解以省下本地模型呼叫。",
    CALENDAR_QUERY_INPUT,
    async (args) => {
      try {
        return await runCalendarQuery(args as Parameters<typeof runCalendarQuery>[0]);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "query_calendar",
    "[deprecated：請改用 calendar_query] 查詢本人日曆：今天/明天有哪些會、幾個會、有沒有空、待回覆的邀請等（唯讀）",
    CALENDAR_QUERY_INPUT,
    async (args) => {
      try {
        return await runCalendarQuery(args as Parameters<typeof runCalendarQuery>[0]);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Tool: calendar_server_card — 能力宣告（Microsoft Research 2025 建議）。
  // 不需 scope：只描述本 server 的 runtime 特性與協作方式，不含任何日曆資料。
  server.tool(
    "calendar_server_card",
    "宣告本 server 的能力、隱私邊界、預期 token 量與延遲，以及強模型建議的協作方式（plan/subtasks/detail）",
    {},
    async () => {
      try {
        return okResult(buildServerCard());
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Tool 8: whoami（身分自我確認；不需額外 scope，只回 token 內既有的身分事實）。
  // 動機：外部 agent 先前無從知道自己「以誰的身分」操作日曆——token 是 JWT，
  // 雖可自行解碼取得 user_sub，但那只是 membership UUID，對 agent 與終端使用者
  // 都不可讀。此工具把身分講清楚，讓 agent 能在回答前確認「我是代 X 在看 X 的日曆」。
  server.tool(
    "whoami",
    "查詢此連線的身分：我是哪個 agent、代表哪位使用者、在哪個 workspace、有哪些 scope",
    {},
    async () => {
      try {
        if (!auth) throw new McpAuthError("unauthorized", "invalid or missing token");
        const onBehalf = auth.user_sub ?? auth.sub;
        const identity = await resolveIdentity(auth.workspace, onBehalf);
        return okResult({
          actor_type: auth.user_sub ? "agent" : "user",
          agent_id: auth.user_sub ? auth.sub : null,
          workspace: { id: auth.workspace, ...(identity?.workspace ?? {}) },
          // 代表誰在操作（唯讀查詢與排會都以此人為主體）
          on_behalf_of: identity
            ? {
                membership_id: identity.membership_id,
                display_name: identity.display_name,
                email: identity.email,
                role: identity.role,
                timezone: identity.timezone,
              }
            : { membership_id: onBehalf },
          scope: auth.scope ?? [],
          // 提醒能力邊界，避免 agent 誤以為可以改行事曆
          capabilities: {
            read_calendar: (auth.scope ?? []).includes("availability.read"),
            write_events: (auth.scope ?? []).includes("event.write"),
            book_resources: (auth.scope ?? []).includes("resource.book"),
            destructive_actions: false,
          },
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

/** stdio 進入點。 */
export async function main() {
  const { auth, source } = resolveDevAuth();
  if (!auth) {
    // 不在載入期崩潰；但沒有有效授權時，明確在 stderr 提示（stdout 專供 MCP 協定）
    process.stderr.write(
      `[mcp] WARNING: no valid dev auth (source=${source}). ` +
        `Set MCP_DEV_WORKSPACE + MCP_DEV_SUB (+ MCP_DEV_SCOPE), or MCP_DEV_TOKEN. ` +
        `Tools will return { error: "unauthorized" }.\n`,
    );
  } else {
    process.stderr.write(`[mcp] dev auth ready (source=${source}, workspace=${auth.workspace})\n`);
  }
  const server = buildMcpServer(auth);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp] scal-calendar-mcp on stdio\n");
}

// 直接執行時啟動（tsx src/mcp/server.ts）
if (process.argv[1] && /mcp[\\/]server\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`[mcp] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
