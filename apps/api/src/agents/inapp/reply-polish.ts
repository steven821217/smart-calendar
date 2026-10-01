import { z } from "zod";
import type { ChatModel } from "../llm.js";

/**
 * 回覆潤飾（優化 A：grounded generation）。
 *
 * 目標：讓制式模板答案讀起來更像 agent 自己在說話，而非填空——但**絕不因潤飾而答錯**。
 *
 * 設計（事實與措辭分離）：
 *  - 事實一律由後端算好（事件清單、數量、成員名單、時間窗），以「不可變事實 tokens」傳入。
 *  - 14B 只被授權「改寫措辭 / 換句話說」，明令不得新增、刪改任何事實。
 *  - 潤飾後做**事實校驗**：每個關鍵事實 token（日期、數字、標題、姓名…）都必須仍原樣出現在
 *    潤飾結果中，且不得冒出原文沒有的日期/數字。任一條不過 → 丟棄潤飾、回退原模板。
 *  - LLM 不可用 / 逾時 / 例外 → 回退原模板。
 *
 * opt-in：INAPP_POLISH=1 才啟用（預設關）。簡單查詢預設走 0 延遲模板；開啟後每次查詢
 * 多一次 14B 呼叫（GPU 上約 1.5s），由部署者權衡體感 vs 延遲。
 */

const PolishSchema = z.object({
  reply: z.string().min(1).max(1200),
});

const SYSTEM =
  "你是行事曆助理。以下提供一段『事實答案』與『必須保留的事實清單』。" +
  "請你用自然、親切、口語的中文『改寫』這段答案，讓它讀起來像你自己在回答，" +
  "但務必遵守：\n" +
  "1. 不可新增任何事實清單以外的資訊（不得杜撰日期、時間、數字、人名、會議名稱）。\n" +
  "2. 事實清單中的每一項（日期、數字、標題、姓名）都必須原封不動出現在你的回覆裡，且只出現一次，不要重複同一個日期或詞。\n" +
  "3. 不可改動任何數字或日期。\n" +
  "4. 保持簡潔，直接講重點；不要加『好的』『當然』之類開場白，也不要結尾客套。\n" +
  "5. 不要保留原文括號內的重複標籤（例如原文已有『今天（9/17）』就不要再自己加一次『今天』）。\n" +
  "只輸出改寫後的回覆文字。";

/** 從純數字/日期樣式抽出「數字類事實」（用於防止 14B 竄改或新增數字）。 */
function numericTokens(s: string): string[] {
  // 抓「9/18」「14:00」「3 個」「10」等數字片段
  return (s.match(/\d+(?:[:/.]\d+)*/g) ?? []).map((x) => x.trim());
}

/**
 * 潤飾一段模板答案。
 * @param template 後端算好的模板答案（事實正確）
 * @param facts    必須保留的關鍵事實 token（日期、標題、姓名、數字字串…），逐一校驗
 * @param model    ChatModel
 * @returns 通過校驗的潤飾文字；任一護欄不過或 LLM 不可用 → 回原 template
 */
export async function polishReply(
  template: string,
  facts: string[],
  model: ChatModel,
): Promise<string> {
  if (process.env.INAPP_POLISH !== "1") return template;
  if (!template.trim()) return template;

  const factList = facts.filter((f) => f && f.trim().length > 0);
  const human =
    `事實答案：\n${template}\n\n` +
    (factList.length ? `必須保留的事實清單（每一項都要原樣出現）：\n${factList.map((f) => `- ${f}`).join("\n")}\n` : "") +
    `\n請改寫這段答案。`;

  let out: string;
  try {
    const timeout = Number(process.env.INAPP_POLISH_TIMEOUT_MS ?? 8000);
    const raw = await Promise.race([
      model.invokeStructured(PolishSchema, [
        { role: "system", content: SYSTEM },
        { role: "human", content: human },
      ]),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("polish timeout")), timeout)),
    ]);
    out = (raw as z.infer<typeof PolishSchema>).reply?.trim() ?? "";
  } catch {
    return template; // LLM 不可用 / 逾時 → 回退模板
  }
  if (!out) return template;

  // 去除殘留的開場白客套（14B 偶爾無視指示）
  out = out.replace(/^(好的|好喔|當然|沒問題|OK)[，,、:：]?\s*/i, "").trim();
  if (!out) return template;

  // ── 事實校驗護欄 ──
  // 1. 每個關鍵事實 token 必須仍原樣出現
  for (const f of factList) {
    if (!out.includes(f)) return template; // 少了事實 → 不可信，回退
  }
  // 1.5 防疊字：任一日期類事實在潤飾結果的出現次數，不應超過它在原模板的次數（+0 容忍），
  //     避免「今天（9/17）今天…」這種 14B 保留 label 又自行重述的贅字。
  const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;
  for (const f of factList) {
    if (/\d/.test(f) && countOf(out, f) > countOf(template, f)) return template;
  }
  // 2. 不得冒出原文（template + facts）沒有的數字/日期（防杜撰數字）
  const allowedNumbers = new Set([...numericTokens(template), ...factList.flatMap(numericTokens)]);
  for (const n of numericTokens(out)) {
    if (!allowedNumbers.has(n)) return template; // 出現新數字 → 幻覺，回退
  }
  // 3. 長度 sanity：潤飾結果不應暴長（防夾帶大段杜撰內容）
  if (out.length > template.length * 3 + 120) return template;

  return out;
}
