import { z } from "zod";
import type { ChatModel } from "../llm.js";

/**
 * 意圖分類（harness：規則為主，14B model 為輔）。
 *
 * 5 類（少而互斥，對弱 model 友善）：
 *  - list_events   查某時段有哪些會（明天有會議嗎 / 今天有什麼事 / 下一個會議）
 *  - count_events  數量/概覽（這週幾個會 / 今天忙不忙）
 *  - find_free     找空檔（明天下午有空嗎 / 哪個時段是空的）
 *  - list_pending  待回覆邀請（誰約我還沒回 / 有沒有待處理）
 *  - schedule      實際排會（幫我約 / 安排 / 訂車）→ 轉委員會
 *
 * 策略：
 *  1) 規則關鍵字先判（覆蓋約 8 成、零成本、確定性）。
 *  2) 規則無法明確判定時，才用 model 從固定 enum 二次裁決。
 *  3) model 回傳非法/例外 → 一律 fallback 規則結果（絕不卡死）。
 */

export type Intent = "list_events" | "count_events" | "find_free" | "list_pending" | "list_members" | "schedule";

const INTENTS: Intent[] = ["list_events", "count_events", "find_free", "list_pending", "list_members", "schedule"];

const IntentSchema = z.object({
  intent: z.enum(["list_events", "count_events", "find_free", "list_pending", "list_members", "schedule", "unknown"]),
});

/** 規則分類：回 Intent 或 null（無法明確判定）。 */
export function classifyByRules(text: string): Intent | null {
  const t = text.toLowerCase().trim();

  // schedule：明確的動作動詞（排/約/安排/訂 + 建立）——放最前，動作優先
  if (/幫我約|幫我排|幫我安排|幫忙約|安排一?個?會|排一?個?會|約.*開會|訂.*車|訂.*會議室|book|schedule a|set up a meeting|arrange/.test(t)) {
    return "schedule";
  }
  // list_pending：待回覆 / RSVP
  if (/待回覆|待處理|還沒回|沒回覆|邀請我|約我.*回|pending|rsvp|誰約我/.test(t)) {
    return "list_pending";
  }
  // find_free：空檔（要在 count/list 之前，因為「有空」含「有」）
  if (/有空|空檔|空閒|有沒有空|哪個?時段|free|available|availability|幾點.*方便|方便的時間/.test(t)) {
    return "find_free";
  }
  // count_events：數量 / 忙碌概覽
  if (/幾個|幾場|多少個?會|忙不忙|忙嗎|滿不滿|how many|count/.test(t)) {
    return "count_events";
  }
  // list_members：問團隊/群組成員名單（放在 list_events 之前，否則「有哪些人」會被會議查詢吃掉）
  if (/有誰|是誰|哪些人|成員|組員|團隊裡?有|小隊有|隊員|member.*(有|是)|誰在.*(團隊|小隊|組)|我的\s*member/i.test(t)) {
    return "list_members";
  }
  // list_events：查有哪些 / 下一個 / 接下來（放最後當較廣的兜底查詢）
  if (/有會議?嗎|有什麼|有哪些|有事嗎|行程|安排嗎|下一個|接下來|待辦|schedule\?|what.*meeting|any meeting|下個會/.test(t)) {
    return "list_events";
  }
  return null;
}

/**
 * 完整分類：規則優先，模糊時 model 兜底。
 * model 只從固定 enum 選（invokeStructured），且失敗/unknown 一律回規則或預設。
 */
export async function classifyIntent(
  text: string,
  model: ChatModel,
  defaultIntent: Intent = "list_events",
): Promise<{ intent: Intent; via: "rules" | "model" | "default" }> {
  const byRule = classifyByRules(text);
  if (byRule) return { intent: byRule, via: "rules" };

  // 規則無法判定 → 交給 model，但用極短、約束式 prompt + 固定 enum
  try {
    const out = await model.invokeStructured(IntentSchema, [
      {
        role: "system",
        content:
          "你是意圖分類器。只輸出一個 intent，從這些選項擇一：" +
          "list_events(查詢某時段有哪些會議/行程)、count_events(問數量或忙不忙)、" +
          "find_free(找空檔/有沒有空)、list_pending(待回覆的邀請)、list_members(問團隊/群組有哪些成員)、schedule(要求實際安排/預約會議或資源)。" +
          "無法判斷時輸出 unknown。只做分類，不要解釋。",
      },
      { role: "human", content: text },
    ]);
    if (out.intent !== "unknown" && (INTENTS as string[]).includes(out.intent)) {
      return { intent: out.intent as Intent, via: "model" };
    }
  } catch {
    // model 不可用或格式壞 → 落回規則預設
  }
  return { intent: defaultIntent, via: "default" };
}
