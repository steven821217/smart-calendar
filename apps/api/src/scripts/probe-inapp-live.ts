// Live end-to-end probe: drive the REAL runInAppAgent (real 14B + real DB via RLS),
// exercising the full harness (route → reconcile → query → optional polish).
// Confirms general questions answer correctly & agent-first, and that reply-polish
// (INAPP_POLISH=1) never corrupts facts (guardrail falls back to template when unsafe).
//
// Run (host, ports from docker-compose.dev.yml up):
//   set -a; . ./.env; set +a
//   export DATABASE_URL=postgres://app_user:$DB_PASSWORD@localhost:5432/$DB_NAME
//   export OPA_URL=http://localhost:8181 REDIS_HOST=localhost REDIS_PORT=6379
//   export LLM_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=local LLM_MODEL=qwen3:14b
//   export INAPP_POLISH=1            # 開潤飾（驗 A）
//   pnpm --filter @scal/api exec tsx src/scripts/probe-inapp-live.ts
import { makeChatModel } from "../agents/llm.js";
import { runInAppAgent } from "../agents/inapp/service.js";
import type { AuthContext } from "../auth/jwt.js";

const TZ = "Asia/Taipei";
// ws-a admin member (a@example.com) — 有 seed 事件；有群組 產品團隊 / Alpha 小隊
const WORKSPACE = process.env.PROBE_WS ?? "";     // 由呼叫端填 ws-a 的 workspace UUID
const MEMBER = process.env.PROBE_MEMBER ?? "";    // 由呼叫端填 a@example.com 的 membership UUID

const QUESTIONS = [
  "明天的產品週會在哪開、有誰參加",
  "我最忙的是星期幾",
  "這週比上週忙嗎",
  "有沒有排過產品的會",
  "今天天氣如何",
  "幫我寫一首詩",
  "我下一個行程是什麼",
  "明天有哪些行程",
];

async function main() {
  if (!WORKSPACE || !MEMBER) {
    console.error("set PROBE_WS and PROBE_MEMBER (ws-a workspace UUID + a@example.com membership UUID)");
    process.exit(2);
  }
  const model = makeChatModel();
  const auth: AuthContext = {
    workspace: WORKSPACE, sub: MEMBER, roles: ["admin"], scope: [],
  } as unknown as AuthContext;

  console.log(`== runInAppAgent live (14B, DB) polish=${process.env.INAPP_POLISH === "1"} ==\n`);
  for (const q of QUESTIONS) {
    const t0 = Date.now();
    try {
      const r = await runInAppAgent(auth, q, TZ, { model });
      const msg = r.message.replace(/\n/g, " ⏎ ");
      console.log(`【${q}】(${Date.now() - t0}ms) kind=${r.kind} intent=${r.intent} via=${r.via}`);
      console.log(`  → ${msg.slice(0, 240)}\n`);
    } catch (e) {
      console.log(`【${q}】 ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
