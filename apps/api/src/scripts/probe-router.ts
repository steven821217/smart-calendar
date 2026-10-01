// Live probe: run REAL qwen3:14b through the agent-first router (routeMessage).
// Confirms the agent decides intent+spec on the first layer across many phrasings.
// Run: LLM_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=local LLM_MODEL=qwen3:14b \
//      pnpm --filter @scal/api exec tsx src/scripts/probe-router.ts
import { makeChatModel } from "../agents/llm.js";
import { routeMessage } from "../agents/inapp/router.js";
import { reconcileSpec } from "../agents/inapp/query-spec.js";
import { windowFromSpec } from "../agents/inapp/time-window.js";

const GROUPS = ["產品團隊", "Alpha 小隊"];
const TZ = "Asia/Taipei";
const NOW = new Date("2026-09-17T02:00:00Z"); // 週四 10:00 台北

const CASES: Array<[string, string]> = [
  // [問句, 期望意圖(人工標註)]
  ["明天有會議嗎？", "list_events"],
  ["今天有什麼事", "list_events"],
  ["我下一個會議是什麼時候", "next_event"],
  ["明天的行程幫我看一下", "list_events"],
  ["這週我有幾個會", "count_events"],
  ["今天忙不忙", "count_events"],
  ["明天的量大概多少", "count_events"],
  ["明天下午有空嗎", "find_free"],
  ["哪個時段是空的", "find_free"],
  ["找得到一小時的空檔嗎", "find_free"],
  ["有沒有人約我還沒回覆", "list_pending"],
  ["有沒有待處理的邀請", "list_pending"],
  ["我的組員有誰", "list_members"],
  ["產品團隊有哪些人", "list_members"],
  ["這組現在都由誰在跑", "list_members"],   // 舊規則會誤判 list_events
  ["Alpha 那隊都有誰", "list_members"],
  ["幫我約產品團隊明天下午開會", "schedule"],
  ["訂週四的公務車", "schedule"],
  ["明天下午想跟工程團隊碰個面討論進度", "schedule"], // 無明確動詞，舊規則判不出
  ["幫我把週五的專案同步會排一下", "schedule"],
  // 邊界 / 易混淆
  ["我這週三下午到週五有什麼會", "list_events"],
  ["這個月還有幾個跟產品團隊的會", "count_events"],
  ["這禮拜五有什麼會", "list_events"],
  // 擴充：更通用的問法 / 已知破綻
  ["Alpha 小隊有哪些人", "list_members"],
  ["產品團隊現在誰是負責人", "list_members"],
  ["週一到週三我有哪些行程", "list_events"],
  ["下週二到週四忙不忙", "count_events"],
  ["後天早上有空嗎", "find_free"],
  ["我今天晚上有事嗎", "list_events"],
  ["這禮拜有沒有跟產品團隊的會", "list_events"],
  ["接下來三天有幾個會", "count_events"],
  ["有沒有人還在等我回覆邀請", "list_pending"],
  ["幫我看看下週的安排", "list_events"],
  ["我最近有什麼會要開", "list_events"],
  ["星期四到星期六有什麼行程", "list_events"],
];

async function main() {
  const model = makeChatModel();
  let agentCount = 0, backstopCount = 0, fallbackCount = 0, hit = 0;
  for (const [text, expected] of CASES) {
    const t0 = Date.now();
    try {
      const r = await routeMessage(text, model);
      const ok = r.intent === expected;
      if (ok) hit++;
      if (r.via === "agent") agentCount++; else if (r.via === "agent+backstop") backstopCount++; else fallbackCount++;
      // 覆核後（DB 實際使用的 spec）+ 時間窗
      const rec = reconcileSpec(r.spec, text, GROUPS);
      const win = windowFromSpec(rec.anchor, rec.weekday_from, rec.weekday_to, TZ, NOW);
      console.log(
        `${ok ? "✓" : "✗"} 「${text}」 → ${r.intent} (期望 ${expected}) [via=${r.via}, ${Date.now() - t0}ms]\n` +
        `    raw : a=${r.spec.anchor} wf=${r.spec.weekday_from} dp=${r.spec.daypart} kw=${r.spec.filter_keyword} g=${r.spec.group_name} o=${r.spec.order}\n` +
        `    覆核: a=${rec.anchor} wf=${rec.weekday_from} wt=${rec.weekday_to} dp=${rec.daypart} kw=${rec.filter_keyword} g=${rec.group_name} → 窗「${win.label}」`,
      );
    } catch (e) {
      console.log(`✗ 「${text}」 ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n== 命中 ${hit}/${CASES.length}；via: agent=${agentCount} agent+backstop=${backstopCount} rules-fallback=${fallbackCount} ==`);
}
main().catch((e) => { console.error(e); process.exit(1); });
