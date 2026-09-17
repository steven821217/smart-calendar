// Probe REAL qwen3:14b + run it through the actual harness (normalize + group reconcile).
// Run: pnpm --filter @scal/api exec tsx src/scripts/probe-14b.ts
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { QuerySpecSchema, normalizeSpec, reconcileSpec } from "../agents/inapp/query-spec.js";
import { windowFromSpec } from "../agents/inapp/time-window.js";

const BASE = process.env.PROBE_BASE || "http://localhost:11434/v1";
const MODEL = process.env.PROBE_MODEL || "qwen3:14b";
const TZ = "Asia/Taipei";
const NOW = new Date("2026-09-17T02:00:00Z"); // 週四 10:00 台北
const GROUPS = ["產品團隊", "Alpha 小隊"]; // 模擬真實 group 清單

const SYSTEM =
  "你是日曆查詢解析器。把中文問題轉成結構化查詢參數。只填欄位、不解釋、不自己算日期。" +
  "『有哪些/什麼會』→list；『幾個/多少』→count；『有沒有空』→find_free；『待回覆』→pending。" +
  "『下午』→afternoon。『跟X的會』→filter_keyword=X。『X團隊/X小隊』整個當 group_name（勿拆）。" +
  "『第一個/最早』→first。沒有的欄位填 null（勿填 \":null\"）。星期：週一=0..週日=6。";

const CASES = [
  // 前兩個修正驗證
  "我明天第一個會議幾點",     // 修正1：單日 anchor 應清掉 weekday 雜訊
  "跟客戶的會議有哪些",       // 修正2：無「下午」→ daypart 應被清成 any
  // 複合
  "我這週三下午到週五有什麼會",
  "這個月還有幾個跟產品團隊的會",
  // 日常正常問句
  "今天下午有沒有空",
  "這禮拜五有什麼會",
  "下禮拜三有會嗎",
  "下週有哪些會議",
  "我今天還有幾個會",
  "明天早上有空嗎",
  "產品團隊這週有會嗎",
  "有沒有人約我還沒回覆",
];

async function main() {
  const chat = new ChatOpenAI({ apiKey: "local", model: MODEL, temperature: 0, configuration: { baseURL: BASE } });
  const structured = chat.withStructuredOutput(QuerySpecSchema);
  for (const c of CASES) {
    const t0 = Date.now();
    try {
      const raw = await structured.invoke([new SystemMessage(SYSTEM), new HumanMessage(c)]);
      const norm = normalizeSpec(raw as never);
      const spec = reconcileSpec(norm, c, GROUPS);
      const win = windowFromSpec(spec.anchor, spec.weekday_from, spec.weekday_to, TZ, NOW);
      console.log(`\n【${c}】 (${Date.now() - t0}ms)`);
      console.log(`  14B raw   : ${JSON.stringify(raw)}`);
      console.log(`  harness後 : ${JSON.stringify(spec)}`);
      console.log(`  時間窗    : ${win.label}  ${win.from_utc} → ${win.to_utc}`);
    } catch (e) {
      console.log(`\n【${c}】 ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
