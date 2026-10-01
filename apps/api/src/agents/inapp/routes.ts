import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeChatModel, type ChatModel, type ChatMessage } from "../llm.js";
import { runInAppAgent, confirmSchedule, confirmAction } from "./service.js";

/**
 * 站內對話 agent 路由（B 方案）。
 *   POST /v1/agent/chat  { text: string }  → { kind, message, intent, via, data }
 * 認證：登入 user 的 JWT（req.auth，sub=membership_id）。授權：以 user 真實 role 經 PDP
 * （查詢走 RLS 只見本 workspace；排會轉委員會，member 無 resource.book 由 PDP 擋）。
 */

/**
 * 站內 stub model（MCP_STUB_MODEL=1，測試/離線截圖用）：
 * agent-first 下，路由第一層本應由 agent 決定；stub 無語意能力，故對「router/意圖分類
 * schema」丟例外，讓 routeMessage 走 rulesFallback（規則分類），只服務委員會節點 schema。
 */
function makeInAppStubModel(): ChatModel {
  const stubMember = process.env.MCP_STUB_MEMBER_ID;
  return {
    async invokeStructured<T>(schema: z.ZodType<T>, _messages: ChatMessage[]): Promise<T> {
      // 探測 schema：router/意圖分類 schema 有 `intent` 欄位 → stub 不路由，交給規則兜底
      const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
      if (shape && "intent" in shape) {
        throw new Error("stub: no LLM routing, defer to rules");
      }
      // 委員會 coordinator schema
      return {
        attendee_ids: stubMember ? [stubMember] : [],
        unresolved_names: [],
        resources: [],
      } as T;
    },
  };
}

const ChatInput = z.object({ text: z.string().min(1).max(1000) });

export function registerInAppAgentRoutes(app: FastifyInstance) {
  const model = process.env.MCP_STUB_MODEL === "1" ? makeInAppStubModel() : makeChatModel();

  app.post("/v1/agent/chat", async (req, reply) => {
    const auth = req.auth!;
    const parsed = ChatInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ type: "…/validation", title: "Unprocessable", status: 422, detail: parsed.error.message });
    }
    // 觀看者時區：由 token 無法直接取，改由 body 選填或預設 workspace 慣用；
    // 這裡用請求標頭或預設 Asia/Taipei（前端會帶 me.timezone）。
    const tz = (req.headers["x-viewer-tz"] as string) || "Asia/Taipei";
    const result = await runInAppAgent(auth, parsed.data.text, tz, { model });
    return result;
  });

  // 一鍵確認：帶排會預覽的 option_token 直接落實（免重跑委員會）。
  const ConfirmInput = z.object({ option_token: z.string().min(1) });
  app.post("/v1/agent/confirm", async (req, reply) => {
    const auth = req.auth!;
    const parsed = ConfirmInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ type: "…/validation", title: "Unprocessable", status: 422, detail: parsed.error.message });
    }
    return confirmSchedule(auth, parsed.data.option_token);
  });

  // 第三波：破壞性動作（reschedule/cancel）第二步——帶 action_token 確認執行。
  const ConfirmActionInput = z.object({ action_token: z.string().min(1) });
  app.post("/v1/agent/confirm-action", async (req, reply) => {
    const auth = req.auth!;
    const parsed = ConfirmActionInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ type: "…/validation", title: "Unprocessable", status: 422, detail: parsed.error.message });
    }
    const tz = (req.headers["x-viewer-tz"] as string) || "Asia/Taipei";
    return confirmAction(auth, parsed.data.action_token, tz);
  });
}
