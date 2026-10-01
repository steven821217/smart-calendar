/**
 * 回歸評測執行器。
 *
 * 用法（服務需已啟動）：
 *   node eval/run.mjs --seed                # 重建固定資料後跑全部題目
 *   node eval/run.mjs                       # 沿用既有 eval/.ctx.json
 *   node eval/run.mjs --tags compound,order # 只跑特定標籤
 *   node eval/run.mjs --ids MU04,PP03       # 只跑特定題目
 *   node eval/run.mjs --label v7-my-change  # 自訂版本標籤
 *
 * 產物：
 *   eval/results/<label>.json  單次完整結果（含每題訊息，便於除錯）
 *   eval/RESULTS.md            版本 × 題目的回歸表（下次更新可直接比對）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CTX_PATH, MATRIX_PATH, PRIVATE_EVENT_TITLES, RESULTS_DIR } from "./config.mjs";
import { QUESTIONS } from "./bank.mjs";
import { seed } from "./seed.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/**
 * GPU preflight：模型若掉回 CPU，整輪延遲數字就完全不可比（實測同一套題目
 * GPU 4.1s vs CPU 數十秒），且過去發生過兩次 CUDA error 800 導致靜默改跑 CPU。
 * 因此這裡直接擋下來，不讓一輪壞掉的測量被寫進回歸表。
 */
async function assertModelsOnGpu() {
  const host = process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434";
  let body;
  try {
    body = await (await fetch(`${host}/api/ps`)).json();
  } catch (err) {
    throw new Error(`無法查詢 ${host}/api/ps（Ollama 沒起來？）：${String(err)}`);
  }
  const loaded = body.models ?? [];
  if (!loaded.length) {
    // 尚未載入：主動戳一次讓它載入後再檢查，避免第一題背負載入時間又無法驗證裝置。
    await fetch(`${host}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model: process.env.LLM_MODEL || "qwen3:14b", prompt: "hi", stream: false, options: { num_predict: 1 } }),
    }).catch(() => {});
    body = await (await fetch(`${host}/api/ps`)).json();
  }
  const report = (body.models ?? []).map((m) => {
    const total = Number(m.size ?? 0);
    const gpu = Number(m.size_vram ?? 0);
    const pct = total > 0 ? Math.round((gpu / total) * 100) : 0;
    return { name: m.name, gpuPercent: pct };
  });
  if (!report.length) throw new Error("Ollama 沒有載入任何模型，無法確認是否使用 GPU");
  const onCpu = report.filter((r) => r.gpuPercent < 90);
  if (onCpu.length) {
    throw new Error(
      `模型未在 GPU 上執行：${onCpu.map((r) => `${r.name}=${r.gpuPercent}% GPU`).join(", ")}。\n` +
      "請先修復（通常是 CUDA error 800，重建 ollama 容器即可），再重跑評測。",
    );
  }
  return report;
}

function parseArgs(argv) {
  const args = { seed: false, tags: null, ids: null, label: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") args.seed = true;
    else if (a === "--tags") args.tags = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--ids") args.ids = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--label") args.label = argv[++i] || null;
  }
  return args;
}

function git(args, fallback = "unknown") {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

/** 版本識別：commit + 是否有未提交改動 + 影響行為的關鍵設定。 */
function versionMeta() {
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain"], "") !== "";
  return {
    commit: sha,
    dirty,
    runAt: new Date().toISOString(),
    fixture: null, // 由 main 依 ctx 填入（資料版本不同 → 部分題目不可直接比較）
    config: {
      iclK: process.env.INAPP_ICL_K ?? "(container default)",
      embedModel: process.env.INAPP_EMBED_MODEL ?? "(container default)",
      llmModel: process.env.LLM_MODEL ?? "(container default)",
    },
  };
}

function nextLabel() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const used = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  return `v${used.length + 1}`;
}

let sessionId;
async function rpc(base, token, body) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  sessionId = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return line ? JSON.parse(line.slice(5).trim()) : { raw: text };
}

async function ask(base, token, question) {
  const started = Date.now();
  const rpcRes = await rpc(base, token, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name: "query_calendar", arguments: { question, viewer_timezone: "Asia/Taipei" } },
  });
  let payload = {};
  try {
    payload = JSON.parse(rpcRes?.result?.content?.[0]?.text ?? "{}");
  } catch {
    payload = {};
  }
  return {
    ms: Date.now() - started,
    toolError: Boolean(rpcRes?.result?.isError),
    kind: payload.kind ?? null,
    intent: payload.intent ?? null,
    via: payload.via ?? null,
    message: String(payload.message ?? ""),
  };
}

/**
 * 期望值可以是字串陣列，也可以是 (ctx) => 字串陣列 的函式。
 * 後者用於「幾場會 / 幾個人」這種跟 fixture 資料量綁定的期望值：
 * 資料擴充時由 seed 重新算出，不會默默失準。
 */
function resolveExpected(value, ctx) {
  return typeof value === "function" ? value(ctx) : value;
}

/** 回傳失敗原因陣列；空陣列 = 通過。隱私規則是全域的，套用於每一題。 */
function evaluate(question, answer, ctx) {
  const failures = [];
  const { expect = {} } = question;
  if (answer.toolError) failures.push("tool error");
  if (!answer.message.trim()) failures.push("empty answer");
  for (const title of PRIVATE_EVENT_TITLES) {
    if (answer.message.includes(title)) failures.push(`PRIVACY LEAK: ${title}`);
  }
  if (expect.kind && answer.kind !== expect.kind) failures.push(`kind=${answer.kind} expected ${expect.kind}`);
  if (expect.kindAny && !expect.kindAny.includes(answer.kind)) failures.push(`kind=${answer.kind} not in ${expect.kindAny.join("|")}`);
  if (expect.notKind && answer.kind === expect.notKind) failures.push(`kind must not be ${expect.notKind}`);
  if (expect.intent && answer.intent !== expect.intent) failures.push(`intent=${answer.intent} expected ${expect.intent}`);
  if (expect.intentAny && !expect.intentAny.includes(answer.intent)) failures.push(`intent=${answer.intent} not in ${expect.intentAny.join("|")}`);
  for (const needle of resolveExpected(expect.contains, ctx) ?? []) {
    if (!answer.message.includes(needle)) failures.push(`missing "${needle}"`);
  }
  const anyOf = resolveExpected(expect.containsAny, ctx);
  if (anyOf && !anyOf.some((n) => answer.message.includes(n))) failures.push(`missing any of ${anyOf.join("|")}`);
  for (const needle of resolveExpected(expect.notContains, ctx) ?? []) {
    if (answer.message.includes(needle)) failures.push(`must not contain "${needle}"`);
  }
  return failures;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function renderMatrix() {
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  const runs = files
    .map((f) => JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8")))
    .sort((a, b) => a.meta.runAt.localeCompare(b.meta.runAt));
  if (!runs.length) return;

  const header = ["| 題號 | 標籤 | 題目 | " + runs.map((r) => r.label).join(" | ") + " |"];
  header.push("|---|---|---|" + runs.map(() => "---|").join(""));

  const rows = [];
  for (const question of QUESTIONS) {
    const cells = runs.map((run) => {
      const hit = run.results.find((r) => r.id === question.id);
      if (!hit) return "–";
      if (hit.failures.some((f) => f.includes("PRIVACY LEAK"))) return "🔴";
      return hit.pass ? "✓" : "✗";
    });
    const text = question.text.replace(/\|/g, "\\|").trim() || "（空白輸入）";
    rows.push(`| ${question.id} | ${question.tags.join(",")} | ${text} | ${cells.join(" | ")} |`);
  }

  const summary = [
    "| 版本 | 執行時間 | commit | 未提交改動 | 資料版本 | ICL_K | 通過 | 隱私洩漏 | median | p90 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...runs.map((r) => {
      const total = r.results.length;
      const passed = r.results.filter((x) => x.pass).length;
      return `| ${r.label} | ${r.meta.runAt.slice(0, 19).replace("T", " ")} | ${r.meta.commit} | ${r.meta.dirty ? "是" : "否"} | ${r.meta.fixture ?? "v1-single-team"} | ${r.meta.config.iclK} | ${passed}/${total} | ${r.summary.leaks} | ${r.summary.medianMs}ms | ${r.summary.p90Ms}ms |`;
    }),
  ];

  const body = [
    "# 智慧日曆 agent 回歸評測結果",
    "",
    "本表由 `node eval/run.mjs` 自動產生。題庫在 `eval/bank.mjs`（題號固定，不可修改既有題目措辭）。",
    "",
    "圖例：`✓` 通過、`✗` 未通過、`🔴` 私有事件洩漏（最嚴重）、`–` 該版本未執行此題。",
    "",
    "## 版本摘要",
    "",
    ...summary,
    "",
    "## 逐題結果",
    "",
    ...header,
    ...rows,
    "",
  ].join("\n");
  writeFileSync(MATRIX_PATH, `${body}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let ctx;
  if (args.seed || !existsSync(CTX_PATH)) {
    console.log("seeding fixtures…");
    ctx = await seed();
  } else {
    ctx = JSON.parse(readFileSync(CTX_PATH, "utf8"));
  }

  const selected = QUESTIONS.filter((q) => {
    if (args.ids) return args.ids.includes(q.id);
    if (args.tags) return q.tags.some((t) => args.tags.includes(t));
    return true;
  });
  if (!selected.length) throw new Error("no questions selected");

  const base = ctx.baseUrl || process.env.EVAL_BASE_URL || "https://127.0.0.1:9443";
  await rpc(base, ctx.agentToken, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eval-runner", version: "1" } },
  });
  await rpc(base, ctx.agentToken, { jsonrpc: "2.0", method: "notifications/initialized" });

  const gpu = await assertModelsOnGpu();
  console.log(`GPU preflight：${gpu.map((g) => `${g.name} ${g.gpuPercent}% GPU`).join("; ")}`);
  const meta = { ...versionMeta(), fixture: ctx.fixtureVersion ?? "v1-single-team", gpu };
  const label = args.label || nextLabel();
  const results = [];
  for (const question of selected) {
    let answer;
    try {
      answer = await ask(base, ctx.agentToken, question.text);
    } catch (err) {
      answer = { ms: 0, toolError: true, kind: null, intent: null, via: null, message: `EXCEPTION ${String(err)}` };
    }
    const failures = evaluate(question, answer, ctx);
    results.push({
      id: question.id,
      tags: question.tags,
      text: question.text,
      timeSensitive: Boolean(question.timeSensitive),
      pass: failures.length === 0,
      failures,
      ...answer,
    });
    const mark = failures.length === 0 ? "✓" : "✗";
    console.log(`${mark} ${question.id} ${answer.ms}ms [${answer.intent ?? "-"}/${answer.kind ?? "-"}] ${question.text}`);
    if (failures.length) console.log(`    ${failures.join("; ")}\n    → ${answer.message.replace(/\n/g, " ⏎ ").slice(0, 160)}`);
  }

  const times = results.map((r) => r.ms).filter((n) => n > 0).sort((a, b) => a - b);
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    leaks: results.filter((r) => r.failures.some((f) => f.includes("PRIVACY LEAK"))).length,
    medianMs: percentile(times, 0.5),
    p90Ms: percentile(times, 0.9),
    maxMs: times.length ? times[times.length - 1] : 0,
  };
  const record = { label, meta, summary, results };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${label}.json`), `${JSON.stringify(record, null, 2)}\n`);
  renderMatrix();

  console.log(
    `\n${label}: ${summary.passed}/${summary.total} pass; leaks=${summary.leaks}; ` +
      `median=${summary.medianMs}ms p90=${summary.p90Ms}ms max=${summary.maxMs}ms`,
  );
  console.log(`結果：eval/results/${label}.json，回歸表：eval/RESULTS.md`);
  if (summary.leaks > 0) process.exitCode = 2;
  else if (summary.passed !== summary.total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
