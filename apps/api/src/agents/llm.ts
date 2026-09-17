import type { z } from "zod";

/**
 * 模型 provider 抽象（REQ-1.3/1.4）。
 *
 * 委員會節點只依賴此介面 → 測試以 stub 注入，不打真實 API（CI 無金鑰）。
 * 產出一律走 zod schema 的 structured output，確保 LLM 回傳被視為「不可信建議」時
 * 仍有型別/結構約束，落實前再經 Service/DB 二次驗證（design §1）。
 */
export interface ChatModel {
  /** 依 schema 產生結構化輸出；messages 為 [system, human] 之類的對話。 */
  invokeStructured<T>(schema: z.ZodType<T>, messages: ChatMessage[]): Promise<T>;
}

export interface ChatMessage {
  role: "system" | "human";
  content: string;
}

export class LlmUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LlmUnavailableError";
  }
}

/**
 * 真實 provider 工廠（預設 @langchain/openai）。
 *
 * REQ-1.3：金鑰缺失時**不得於載入期崩潰**；此工廠可被無條件建構，
 * 只有在 `invokeStructured` 真正呼叫時才 fail-closed（丟 LlmUnavailableError）。
 * @langchain 套件亦以 dynamic import 延後載入，避免測試/離線環境的載入期依賴。
 */
export function makeChatModel(): ChatModel {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.LLM_BASE_URL || undefined;

  return {
    async invokeStructured<T>(schema: z.ZodType<T>, messages: ChatMessage[]): Promise<T> {
      if (!apiKey) {
        throw new LlmUnavailableError(
          "OPENAI_API_KEY not configured; committee cannot call the LLM",
        );
      }
      // 延後載入，載入期不依賴 @langchain（REQ-1.3）
      const [{ ChatOpenAI }, { SystemMessage, HumanMessage }] = await Promise.all([
        import("@langchain/openai"),
        import("@langchain/core/messages"),
      ]);
      const chat = new ChatOpenAI({
        apiKey,
        model,
        temperature: 0,
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
      });
      const structured = chat.withStructuredOutput(schema);
      const lcMessages = messages.map((m) =>
        m.role === "system" ? new SystemMessage(m.content) : new HumanMessage(m.content),
      );
      try {
        return (await structured.invoke(lcMessages)) as T;
      } catch (e) {
        throw new LlmUnavailableError(
          `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}
