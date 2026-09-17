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
import { runInAppAgent } from "../agents/inapp/service.js";

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

  // Tool 7: query_calendar（唯讀查詢，availability.read）——外部 agent 問個人日曆問題。
  // 複用站內 agent 查詢核心：嚴格個人隔離（本人 own+participant）、時間規則算、14B harness。
  server.tool(
    "query_calendar",
    "查詢本人日曆：今天/明天有哪些會、幾個會、有沒有空、待回覆的邀請等（唯讀；僅本人的行程，查不到他人）",
    {
      question: z.string().min(1).max(1000).describe("自然語言問題，如「明天下午有哪些會」"),
      viewer_timezone: z.string().optional().describe("IANA 時區，預設 Asia/Taipei"),
    },
    async (args) => {
      try {
        await guardTool(auth, "query_calendar", "event.read", { type: "event" });
        const model = stubOpts.model ?? makeChatModel();
        // M2M token 的 sub=agent_id；查詢「本人日曆」的本人是授權該 agent 的 user（user_sub）。
        const onBehalf = auth!.user_sub ?? auth!.sub;
        const queryAuth = { ...auth!, sub: onBehalf };
        const reply = await runInAppAgent(queryAuth, args.question, args.viewer_timezone ?? "Asia/Taipei", { model });
        // query_calendar 僅供查詢；若被判為排會意圖，引導改用 delegate_complex_scheduling。
        if (reply.intent === "schedule") {
          return okResult({ kind: "not_a_query", message: "這是排程需求，請改用 delegate_complex_scheduling 工具。" });
        }
        return okResult({ kind: reply.kind, message: reply.message, intent: reply.intent, data: reply.data });
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
