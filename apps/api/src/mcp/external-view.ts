/**
 * 外部 agent 專用的回應整形（detail 分層 + 分頁 + 不確定性標記）。
 *
 * 為什麼需要分層：
 * 本地 14B 需要「已經寫好的一句話」，但外部強模型需要的是**可驗證的結構化事實**。
 * 同一份回應餵給兩者，等於把本地模型的猜測變成外部模型的既定前提。
 *
 * 依據（企業研究，非同行評審，但有公開實測數據）：
 *  - Microsoft Research 2025-09《Tool-space interference in the MCP era》：
 *    調查 1,470 個實際 MCP server，工具回應長度中位數 98 tokens，最大者平均 557,766 tokens；
 *    過長回應可讓端到端效能下降達 91%，工具空間過大可下降達 85%。
 *    → 因此這裡強制分頁與硬上限，並在 server card 宣告預期 token 量。
 *  - Anthropic 2025-11《Code execution with MCP》：progressive disclosure（呼叫端自選細節層級）、
 *    「回傳前先過濾」可把 150k tokens 降到 2k。
 *    → 因此 detail 預設 brief，evidence 只在外部 agent 明確要求時才附上。
 */

import type { AgentReply, DecisionNote } from "../agents/inapp/service.js";

/**
 * brief/structured/evidence 由呼叫端指定要多少細節；
 * auto 是協作模式：由本地先自評能不能答，決定自己答或附上事實請呼叫端接手。
 */
export type DetailLevel = "brief" | "structured" | "evidence" | "auto";

/** 單次回應的硬上限：超過就截斷並標記，避免塞爆呼叫端 context。 */
const MAX_ITEMS_PER_PAGE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_MESSAGE_CHARS = 2000;

interface PageInfo {
  page: number;
  page_size: number;
  total: number;
  returned: number;
  has_more: boolean;
}

function paginate<T>(items: T[], page: number, pageSize: number): { slice: T[]; info: PageInfo } {
  const size = Math.min(Math.max(1, pageSize), MAX_ITEMS_PER_PAGE);
  const current = Math.max(1, page);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    slice,
    info: {
      page: current,
      page_size: size,
      total: items.length,
      returned: slice.length,
      has_more: start + slice.length < items.length,
    },
  };
}

/** 事件的外部視圖：只暴露呼叫端推理需要的欄位，不外流內部 id 之外的實作細節。 */
function eventView(o: Record<string, unknown>) {
  return {
    event_id: o.event_id ?? o.id ?? null,
    title: o.title ?? null,
    start_utc: o.occurrence_start_utc ?? o.start_utc ?? null,
    end_utc: o.occurrence_end_utc ?? o.end_utc ?? null,
    location: o.location ?? null,
    timezone: o.timezone ?? null,
    created_by_agent: o.source === "agent",
  };
}

function slotView(s: Record<string, unknown>) {
  return { start_utc: s.start_utc ?? null, end_utc: s.end_utc ?? null };
}

/**
 * 把本地 agent 的回覆整形成外部 agent 要的層級。
 *
 * brief     ：與站內完全相同（預設；既有呼叫端行為不變）
 * structured：加上結構化事實與分頁，message 明確標示為「本地草稿」
 * evidence  ：再加上決策依據與不確定性標記，讓外部 agent 自行覆核
 */
export function shapeForExternalAgent(
  reply: AgentReply,
  opts: { detail: DetailLevel; page?: number; pageSize?: number },
): Record<string, unknown> {
  const base = {
    kind: reply.kind,
    intent: reply.intent ?? null,
    message: reply.message.length > MAX_MESSAGE_CHARS
      ? `${reply.message.slice(0, MAX_MESSAGE_CHARS)}…（已截斷）`
      : reply.message,
  };
  if (opts.detail === "brief") {
    return { ...base, data: reply.data };
  }

  const data = (reply.data ?? {}) as Record<string, unknown>;
  const rawEvents = Array.isArray(data.events) ? (data.events as Record<string, unknown>[]) : [];
  const rawSlots = Array.isArray(data.slots) ? (data.slots as Record<string, unknown>[]) : [];
  const events = paginate(rawEvents, opts.page ?? 1, opts.pageSize ?? DEFAULT_PAGE_SIZE);
  const slots = paginate(rawSlots, opts.page ?? 1, opts.pageSize ?? DEFAULT_PAGE_SIZE);

  const structured: Record<string, unknown> = {
    ...base,
    // message 是本地 14B 的措辭，對外部 agent 只是參考，不是事實來源
    local_draft_answer: base.message,
    facts: {
      events: events.slice.map(eventView),
      free_slots: slots.slice.map(slotView),
      groups: data.groups ?? null,
      count: data.count ?? null,
      detail: data.detail ?? null,
      window: data.window ?? null,
      parts: Array.isArray(data.parts) ? (data.parts as Record<string, unknown>[]).map((p) => ({
        request: p.request ?? null,
        // 子回答同樣只是本地草稿
        local_draft_answer: (p.reply as { message?: string } | undefined)?.message ?? null,
        kind: (p.reply as { kind?: string } | undefined)?.kind ?? null,
      })) : null,
    },
    pagination: {
      events: rawEvents.length ? events.info : null,
      free_slots: rawSlots.length ? slots.info : null,
    },
    query_spec: data.spec ?? null,
    scope: {
      // 隱私不變式在 server 端強制，外部 agent 無論多強都拿不到別人的私人行程
      visibility: "requester_own_and_participating_events_only",
      excludes: "other_members_private_events",
    },
  };
  delete (structured as { message?: unknown }).message;

  if (opts.detail === "structured") return structured;

  const trace: DecisionNote[] = reply.trace ?? [];
  const uncertain = trace.filter((t) => t.uncertain);
  return {
    ...structured,
    evidence: {
      decisions: trace,
      // 讓外部 agent 一眼看出哪幾步是本地模型的推測
      uncertain_steps: uncertain.map((t) => ({ step: t.step, note: t.note })),
      needs_external_verification: uncertain.length > 0,
      local_model: process.env.LLM_MODEL ?? "qwen3:14b",
      local_model_caveat:
        "本地路由模型參數量小（14B）。標記 uncertain 的步驟（候選重排、語法補抽）可能選錯，" +
        "呼叫端若有更強的理解能力，建議改用 plan 或 subtasks 參數自行決定意圖與槽位。",
    },
  };
}

export { DEFAULT_PAGE_SIZE, MAX_ITEMS_PER_PAGE };
