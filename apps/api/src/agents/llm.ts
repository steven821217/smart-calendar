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
 * 基準配置（實測擇優，可用環境變數覆蓋做 A/B）：
 *   INAPP_LLM_MODE = "json"（**預設**，withStructuredOutput）| "tools"（原生 function-calling）
 *   INAPP_LLM_THINK = "0"（**預設**，關 thinking）| "1"（開）
 *   temperature 一律 0。
 *
 * 為何預設 json 而非 tools：實測 qwen3:14b（bench-llm-modes.ts）——
 *   json + think:off = 22/22 命中、~2.0s/題；tools = 13/22（新意圖全塌成 list_events）、~2.8s/題。
 *   qwen3 的 tool-calling 對中文分類明顯弱於 JSON structured output，故基準用 json。
 *   tools 模式保留（環境變數可切），供日後換更強模型時比較。
 *
 * REQ-1.3：金鑰缺失時**不得於載入期崩潰**；此工廠可被無條件建構，
 * 只有在 `invokeStructured` 真正呼叫時才 fail-closed（丟 LlmUnavailableError）。
 */
export function makeChatModel(): ChatModel {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.LLM_BASE_URL || undefined;
  const mode = (process.env.INAPP_LLM_MODE ?? "json").toLowerCase(); // 基準：json（實測較 tools 準且快）
  const thinking = process.env.INAPP_LLM_THINK === "1"; // 預設關 thinking

  // ollama 關 thinking：OpenAI 相容端點透過 chat_template_kwargs.enable_thinking=false。
  // 對雲端 OpenAI 無此參數但無害（會被忽略）。
  const modelKwargs = thinking ? undefined : { chat_template_kwargs: { enable_thinking: false } };

  return {
    async invokeStructured<T>(schema: z.ZodType<T>, messages: ChatMessage[]): Promise<T> {
      if (!apiKey) {
        throw new LlmUnavailableError(
          "OPENAI_API_KEY not configured; committee cannot call the LLM",
        );
      }
      const [{ ChatOpenAI }, { SystemMessage, HumanMessage }] = await Promise.all([
        import("@langchain/openai"),
        import("@langchain/core/messages"),
      ]);
      const chat = new ChatOpenAI({
        apiKey,
        model,
        temperature: 0,
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
        ...(modelKwargs ? { modelKwargs } : {}),
      });
      const lcMessages = messages.map((m) =>
        m.role === "system" ? new SystemMessage(m.content) : new HumanMessage(m.content),
      );

      if (mode === "tools") {
        // 基準：原生 function-calling。把 schema 綁成一個 tool 並用 tool_choice 強制呼叫，
        // 從 tool_calls[0].args 取結構化參數（qwen3 tool-calling 較 JSON mode 穩定）。
        const bound = chat.bindTools(
          [{ name: "extract", description: "抽取結構化參數", schema }],
          { tool_choice: "extract" },
        );
        try {
          const res = await bound.invoke(lcMessages);
          const call = res.tool_calls?.[0];
          if (!call) throw new LlmUnavailableError("model returned no tool_call");
          return schema.parse(call.args) as T;
        } catch (e) {
          if (e instanceof LlmUnavailableError) throw e;
          throw new LlmUnavailableError(
            `LLM tool-call failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // 對照：JSON schema structured output（舊路徑）。
      const structured = chat.withStructuredOutput(schema);
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
