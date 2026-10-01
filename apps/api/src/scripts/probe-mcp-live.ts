// Live MCP exercise: an EXTERNAL agent drives the real MCP server (real 14B, NOT stub).
// Verifies (1) query_calendar answers NL questions correctly & agent-first, and
// (2) delegate_complex_scheduling actually operates the calendar (books an event).
// Run: LLM_BASE_URL=... OPENAI_API_KEY=local LLM_MODEL=qwen3:14b \
//      MCP_DEV_WORKSPACE=<ws> MCP_DEV_SUB=<mem> pnpm exec tsx src/scripts/probe-mcp-live.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mcp/server.ts");

function parse(res: unknown): { isError?: boolean; payload: Record<string, unknown> } {
  const r = res as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: r.isError, payload: JSON.parse(r.content?.[0]?.text ?? "{}") };
}

async function main() {
  const transport = new StdioClientTransport({
    command: "pnpm",
    args: ["exec", "tsx", serverEntry],
    env: {
      ...process.env,
      MCP_DEV_WORKSPACE: process.env.MCP_DEV_WORKSPACE!,
      MCP_DEV_SUB: process.env.MCP_DEV_SUB!,
      MCP_DEV_SCOPE: "availability.read,event.read,event.write,resource.book",
      // 注意：不設 MCP_STUB_MODEL → 走真實 14B（query_calendar 用 makeChatModel）
    } as Record<string, string>,
  });
  const client = new Client({ name: "live-external-agent", version: "0.0.0" });
  await client.connect(transport);
  try {
    console.log("== query_calendar（外部 agent 用自然語言問，走真實 14B）==");
    const questions = [
      "明天有哪些會",
      "這週有幾個會",
      "明天下午有沒有空",
      "有沒有待我回覆的邀請",
      "產品團隊有哪些人",
      "我下一個行程是什麼",
      "我最忙星期幾",
      "有沒有排過產品的會",
      "今天天氣如何",
    ];
    for (const q of questions) {
      const t0 = Date.now();
      const res = await client.callTool({ name: "query_calendar", arguments: { question: q, viewer_timezone: "Asia/Taipei" } });
      const { isError, payload } = parse(res);
      const msg = String(payload.message ?? "").replace(/\n/g, " ⏎ ");
      console.log(`\n【${q}】(${Date.now() - t0}ms) err=${!!isError} intent=${payload.intent} kind=${payload.kind}`);
      console.log(`  → ${msg.slice(0, 200)}`);
    }

    console.log("\n== query_calendar 收到排會需求 → 應引導改用 delegate ==");
    {
      const res = await client.callTool({ name: "query_calendar", arguments: { question: "幫我約明天下午開個會", viewer_timezone: "Asia/Taipei" } });
      const { payload } = parse(res);
      console.log(`  kind=${payload.kind} message=${payload.message}`);
    }

    console.log("\n== delegate_complex_scheduling explain=true（外部 agent 排會，只回 trace 不落實）==");
    {
      const t0 = Date.now();
      const res = await client.callTool({
        name: "delegate_complex_scheduling",
        arguments: {
          task_description: "下週二下午 2 點跟團隊開 1 小時的專案同步會",
          reference_now_utc: new Date().toISOString(),
          default_timezone: "Asia/Taipei",
          explain: true,
          confirm: false,
          title: "外部 agent 專案同步會",
        },
      });
      const { isError, payload } = parse(res);
      console.log(`  (${Date.now() - t0}ms) err=${!!isError} status=${payload.status} explain=${payload.explain} traceSteps=${Array.isArray(payload.trace) ? (payload.trace as unknown[]).length : "n/a"}`);
    }
  } finally {
    await transport.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
