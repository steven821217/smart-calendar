/**
 * 外部 agent 協作評測器。
 *
 * 目的：把「強外部 agent 經 MCP 與本地 agent 協作」的過程**留下可稽核的紀錄**，
 * 而不是只留一個結論。因此每一題都記錄：呼叫了哪些工具、拿到什麼證據、
 * 最後組裝出的答案，再用與本地 agent 完全相同的期望值評分。
 *
 * 為什麼由人（外部強模型）手動組裝答案而不是自動化：
 * 本機只有 qwen3:14b，若用它當「外部強 agent」就失去對照意義。
 * 這裡的外部 agent 角色由實際的強模型扮演，透過下列子命令留痕。
 *
 * 用法：
 *   node eval/external.mjs tools                      列出可用工具
 *   node eval/external.mjs call <id> <tool> '<json>'   代外部 agent 呼叫工具並記錄
 *   node eval/external.mjs answer <id> '<答案>'         記錄外部 agent 組裝的最終答案
 *   node eval/external.mjs score --label ext-v1        依題庫期望值評分並產生比較表
 *   node eval/external.mjs show <id>                   檢視某題的完整 transcript
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_PATH, EVAL_DIR, PRIVATE_EVENT_TITLES, RESULTS_DIR } from "./config.mjs";
import { QUESTIONS } from "./bank.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// 自簽憑證的警告會混進 transcript 輸出，這裡靜音（僅評測環境）
process.removeAllListeners("warning");

/**
 * transcript 路徑可用 EVAL_TRANSCRIPT 指定，讓不同的外部 agent 各自留獨立紀錄
 * （否則後跑的 agent 會覆蓋前一個的答案，兩者就無法對照）。
 */
const TRANSCRIPT_PATH = process.env.EVAL_TRANSCRIPT
  ? (process.env.EVAL_TRANSCRIPT.startsWith("/") ? process.env.EVAL_TRANSCRIPT : join(EVAL_DIR, process.env.EVAL_TRANSCRIPT))
  : join(EVAL_DIR, "external-transcript.json");
const comparePathFor = (label) => join(EVAL_DIR, `EXTERNAL-${label}.md`);

function loadCtx() {
  if (!existsSync(CTX_PATH)) throw new Error(`找不到 ${CTX_PATH}，請先執行 node eval/run.mjs --seed`);
  return JSON.parse(readFileSync(CTX_PATH, "utf8"));
}

function loadTranscript() {
  return existsSync(TRANSCRIPT_PATH) ? JSON.parse(readFileSync(TRANSCRIPT_PATH, "utf8")) : { entries: {} };
}

function saveTranscript(t) {
  writeFileSync(TRANSCRIPT_PATH, `${JSON.stringify(t, null, 2)}\n`);
}

let sessionId;
async function rpc(ctx, body) {
  const res = await fetch(`${ctx.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.agentToken}`,
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

async function connect(ctx) {
  await rpc(ctx, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "external-strong-agent", version: "1" } },
  });
  await rpc(ctx, { jsonrpc: "2.0", method: "notifications/initialized" });
}

async function callTool(ctx, tool, args) {
  const started = Date.now();
  const res = await rpc(ctx, {
    jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9),
    method: "tools/call", params: { name: tool, arguments: args },
  });
  let payload;
  try {
    payload = JSON.parse(res?.result?.content?.[0]?.text ?? "{}");
  } catch {
    payload = { raw: res };
  }
  return { ms: Date.now() - started, tool, args, payload, isError: Boolean(res?.result?.isError) };
}

/** 與 run.mjs 相同的評分規則（含全域隱私檢查），確保兩條路徑可直接比較。 */
function resolveExpected(value, ctx) {
  return typeof value === "function" ? value(ctx) : value;
}

function evaluate(question, message, ctx) {
  const failures = [];
  const { expect = {} } = question;
  if (!message.trim()) failures.push("empty answer");
  for (const title of PRIVATE_EVENT_TITLES) {
    if (message.includes(title)) failures.push(`PRIVACY LEAK: ${title}`);
  }
  for (const needle of resolveExpected(expect.contains, ctx) ?? []) {
    if (!message.includes(needle)) failures.push(`missing "${needle}"`);
  }
  const anyOf = resolveExpected(expect.containsAny, ctx);
  if (anyOf && !anyOf.some((n) => message.includes(n))) failures.push(`missing any of ${anyOf.join("|")}`);
  for (const needle of resolveExpected(expect.notContains, ctx) ?? []) {
    if (message.includes(needle)) failures.push(`must not contain "${needle}"`);
  }
  return failures;
}

function renderComparison(label, ctx, transcript) {
  const localRuns = readdirSync(RESULTS_DIR)
    // 只取本地 agent 的結果檔；外部協作結果（*.external.json）不是基準
    .filter((f) => f.endsWith(".json") && !f.endsWith(".external.json"))
    .map((f) => JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8")))
    .sort((a, b) => a.meta.runAt.localeCompare(b.meta.runAt));
  const latestLocal = localRuns[localRuns.length - 1];
  const localById = new Map((latestLocal?.results ?? []).map((r) => [r.id, r]));

  const ids = Object.keys(transcript.entries).filter((id) => transcript.entries[id].answer);
  // id 對不上題庫是最容易靜默失敗的地方（實測 subagent 把 EX01 寫成 01，結果計分變 0/0）
  const unknown = ids.filter((id) => !QUESTIONS.some((q) => q.id === id));
  if (unknown.length) {
    console.warn(`警告：transcript 中有 ${unknown.length} 個 id 不在題庫裡，將被忽略：${unknown.join(", ")}`);
  }
  if (ids.length && ids.length === unknown.length) {
    throw new Error("transcript 中沒有任何 id 對得上題庫；請確認記錄答案時用的題號與題庫一致。");
  }
  const rows = [];
  let extPass = 0;
  let localPass = 0;
  let extMs = 0;
  let localMs = 0;
  for (const id of ids) {
    const question = QUESTIONS.find((q) => q.id === id);
    if (!question) continue;
    const entry = transcript.entries[id];
    const failures = evaluate(question, entry.answer, ctx);
    const local = localById.get(id);
    const localFail = local ? !local.pass : null;
    if (failures.length === 0) extPass++;
    if (local?.pass) localPass++;
    const toolMs = entry.calls.reduce((sum, c) => sum + c.ms, 0);
    extMs += toolMs;
    localMs += local?.ms ?? 0;
    rows.push({
      id,
      text: question.text,
      localOk: local ? local.pass : null,
      localMs: local?.ms ?? null,
      extOk: failures.length === 0,
      extMs: toolMs,
      calls: entry.calls.length,
      extFailures: failures,
      localFailures: local?.failures ?? [],
    });
  }

  const mark = (ok) => (ok === null ? "–" : ok ? "✓" : "✗");
  const lines = [
    "# 本地 agent vs 外部 agent 協作：同題比較",
    "",
    "本表由 `node eval/external.mjs score` 產生。兩條路徑用**完全相同的期望值**評分（含全域隱私檢查），",
    "因此可直接比較。外部 agent 的每一次工具呼叫與取得的證據都留在 `eval/external-transcript.json`。",
    "",
    `- 本地基準版本：\`${latestLocal?.label ?? "(無)"}\``,
    `- 外部協作版本：\`${label}\``,
    `- transcript：\`${TRANSCRIPT_PATH.replace(`${EVAL_DIR}/`, "eval/")}\``,
    `- 題數：${rows.length}`,
    `- 通過率：本地 ${localPass}/${rows.length}　外部協作 ${extPass}/${rows.length}`,
    `- 本地耗時合計：${localMs}ms　外部協作工具耗時合計：${extMs}ms`,
    "",
    "| 題號 | 題目 | 本地 | 本地延遲 | 外部協作 | 工具耗時 | 呼叫次數 |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.id} | ${r.text} | ${mark(r.localOk)} | ${r.localMs ?? "–"}ms | ${mark(r.extOk)} | ${r.extMs}ms | ${r.calls} |`,
    ),
    "",
    "## 失敗細節",
    "",
  ];
  for (const r of rows) {
    if (r.localOk === false || !r.extOk) {
      lines.push(`### ${r.id} ${r.text}`);
      if (r.localOk === false) lines.push(`- 本地未通過：${r.localFailures.join("; ")}`);
      if (!r.extOk) lines.push(`- 外部協作未通過：${r.extFailures.join("; ")}`);
      lines.push("");
    }
  }
  writeFileSync(comparePathFor(label), `${lines.join("\n")}\n`);

  const record = {
    label,
    mode: "external-agent-collaboration",
    createdAt: new Date().toISOString(),
    localBaseline: latestLocal?.label ?? null,
    summary: {
      total: rows.length,
      externalPassed: extPass,
      localPassed: localPass,
      externalToolMsTotal: extMs,
      localMsTotal: localMs,
      leaks: rows.filter((r) => r.extFailures.some((f) => f.includes("PRIVACY LEAK"))).length,
    },
    results: rows,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${label}.external.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const ctx = loadCtx();
  const transcript = loadTranscript();

  if (cmd === "tools") {
    await connect(ctx);
    const res = await rpc(ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    for (const t of res.result.tools) console.log(`${t.name}\n  ${t.description}\n`);
    return;
  }

  if (cmd === "call") {
    const [id, tool, argsJson] = rest;
    if (!id || !tool) throw new Error("用法：call <id> <tool> '<json args>'");
    await connect(ctx);
    const args = argsJson ? JSON.parse(argsJson) : {};
    const result = await callTool(ctx, tool, args);
    transcript.entries[id] ??= { calls: [], answer: null };
    transcript.entries[id].calls.push(result);
    saveTranscript(transcript);
    console.log(JSON.stringify(result.payload, null, 2));
    console.error(`(${result.ms}ms, 已記錄為 ${id} 的第 ${transcript.entries[id].calls.length} 次呼叫)`);
    return;
  }

  if (cmd === "answer") {
    const [id, ...answerParts] = rest;
    const answer = answerParts.join(" ");
    if (!id || !answer) throw new Error("用法：answer <id> '<答案>'");
    transcript.entries[id] ??= { calls: [], answer: null };
    transcript.entries[id].answer = answer;
    saveTranscript(transcript);
    console.log(`已記錄 ${id} 的答案（${answer.length} 字）`);
    return;
  }

  if (cmd === "show") {
    const [id] = rest;
    console.log(JSON.stringify(transcript.entries[id] ?? null, null, 2));
    return;
  }

  if (cmd === "score") {
    const labelIdx = rest.indexOf("--label");
    const label = labelIdx >= 0 ? rest[labelIdx + 1] : "ext-v1";
    const record = renderComparison(label, ctx, transcript);
    console.log(
      `${label}: 外部協作 ${record.summary.externalPassed}/${record.summary.total}　` +
      `本地 ${record.summary.localPassed}/${record.summary.total}　leaks=${record.summary.leaks}`,
    );
    console.log(`比較表：${comparePathFor(label)}`);
    return;
  }

  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(0, 26).join("\n"));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
