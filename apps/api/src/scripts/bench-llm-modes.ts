// Baseline A/B benchmark: qwen3:14b router across 4 configs
//   mode = tools (native function-calling) | json (withStructuredOutput)
//   think = off (enable_thinking:false) | on
// Reports hit-rate (vs human labels) + latency per config, to pick the best baseline.
//
// Run (host):
//   set -a; . ./.env; set +a
//   export LLM_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=local LLM_MODEL=qwen3:14b
//   pnpm --filter @scal/api exec tsx src/scripts/bench-llm-modes.ts
import { makeChatModel } from "../agents/llm.js";
import { routeMessage } from "../agents/inapp/router.js";
import { clearRouteCache } from "../agents/inapp/route-cache.js";

const CASES: Array<[string, string]> = [
  // --- 基本查詢 ---
  ["明天有會議嗎？", "list_events"],
  ["今天有什麼事", "list_events"],
  ["這週我有幾個會", "count_events"],
  ["今天忙不忙", "count_events"],
  ["明天下午有空嗎", "find_free"],
  ["有沒有待處理的邀請", "list_pending"],
  ["我的組員有誰", "list_members"],
  ["產品團隊有哪些人", "list_members"],
  ["Alpha 那隊都有誰", "list_members"],
  ["幫我約產品團隊明天下午開會", "schedule"],
  ["訂週四的公務車", "schedule"],
  ["我這週三下午到週五有什麼會", "list_events"],
  ["這個月還有幾個跟產品團隊的會", "count_events"],
  // --- 新意圖 ---
  ["我下一個行程是什麼", "next_event"],
  ["明天的產品週會在哪開", "event_detail"],
  ["有沒有排過產品的會", "search_events"],
  ["我跟 Mia 有沒有共同的會", "events_with_person"],
  ["幫我找明天兩小時的空", "find_free"],
  ["我最忙的是星期幾", "stats"],
  ["這週比上週忙嗎", "compare_load"],
  ["今天天氣如何", "out_of_scope"],
  ["幫我寫一首詩", "out_of_scope"],
  // --- 口語 / 模糊 ---
  ["等一下我要幹嘛", "next_event"],
  ["接下來有啥事", "next_event"],
  ["我今天還有事嗎", "list_events"],
  ["禮拜五排滿了沒", "count_events"],
  ["下週二到週四忙不忙", "count_events"],
  ["幫我看看這禮拜", "list_events"],
  ["有沒有人在等我回覆", "list_pending"],
  ["誰約我還沒回", "list_pending"],
  ["我跟老闆下次什麼時候見", "events_with_person"],
  ["那個週會開多久", "event_detail"],
  ["週會有誰要來", "event_detail"],
  ["找一下有沒有牙醫的預約", "search_events"],
  ["我上次跟客戶開會是什麼時候", "search_events"],
  ["這個月我平均一天幾個會", "stats"],
  ["我下午是不是常在開會", "stats"],
  ["這個月比上個月會變多了嗎", "compare_load"],
  ["幫我找下週三整個下午的空", "find_free"],
  ["Alpha 小隊現在誰負責", "list_members"],
  ["幫我安排跟工程團隊下週碰面", "schedule"],
  // --- 更多非日曆（應擋掉）---
  ["1 加 1 等於多少", "out_of_scope"],
  ["幫我訂一張機票", "out_of_scope"],
  ["你是誰做的", "out_of_scope"],
  ["Python 怎麼寫迴圈", "out_of_scope"],
  ["講個笑話來聽", "out_of_scope"],
  ["幫我發個 email 給老闆", "out_of_scope"],
  ["台北到高雄怎麼去", "out_of_scope"],
  // --- 邊界：像閒聊但其實是日曆 ---
  ["我最近是不是很閒", "count_events"],
];

async function runConfig(mode: string, think: string): Promise<{ hit: number; total: number; ms: number; misses: string[] }> {
  process.env.INAPP_LLM_MODE = mode;
  process.env.INAPP_LLM_THINK = think;
  const model = makeChatModel();
  let hit = 0, ms = 0;
  const misses: string[] = [];
  for (const [text, expected] of CASES) {
    clearRouteCache();
    const t0 = Date.now();
    try {
      const r = await routeMessage(text, model);
      ms += Date.now() - t0;
      if (r.intent === expected) hit++;
      else misses.push(`「${text}」→${r.intent}(期望${expected})`);
    } catch (e) {
      ms += Date.now() - t0;
      misses.push(`「${text}」ERROR ${e instanceof Error ? e.message : e}`);
    }
  }
  return { hit, total: CASES.length, ms, misses };
}

async function main() {
  const configs: Array<[string, string, string]> = [
    ["json", "0", "json + think:off（現行基準）"],
  ];
  const results: Array<{ label: string; hit: number; total: number; ms: number; misses: string[] }> = [];
  for (const [mode, think, label] of configs) {
    process.stdout.write(`\n=== ${label} ===\n`);
    const r = await runConfig(mode, think);
    results.push({ label, ...r });
    console.log(`  命中 ${r.hit}/${r.total}　平均 ${Math.round(r.ms / r.total)}ms/題　總 ${(r.ms / 1000).toFixed(1)}s`);
    if (r.misses.length) console.log("  誤判：\n    " + r.misses.join("\n    "));
  }
  console.log("\n==== 總表 ====");
  for (const r of results) {
    console.log(`  ${r.label.padEnd(30)} 命中 ${r.hit}/${r.total}　${Math.round(r.ms / r.total)}ms/題`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
