/**
 * MCP Server Card：向呼叫端宣告這台 server 的 runtime 特性與協作方式。
 *
 * 依據 Microsoft Research 2025-09《Tool-space interference in the MCP era》的
 * server 開發者建議：「發布 server card，明確列出工具的 runtime 特性（預期 token 量、
 * 預期延遲），並指出測試過哪些 model/agent/client、如何測的、已知不相容」。
 * 其調查指出 MCP server 對所有 client 呈現同一組工具是主要失效來源之一。
 *
 * 這裡的數字全部來自本專案實測（313 題回歸套件，RTX 5060 Ti + qwen3:14b），
 * 不是估計值；若硬體或模型更換，請重新量測後更新。
 */

export interface ServerCard {
  server: Record<string, unknown>;
  privacy: Record<string, unknown>;
  /** 每個查詢意圖會回什麼（工具可發現性：呼叫端不必猜） */
  query_intents: Record<string, string>;
  /** plan 可用的槽位分類說明 */
  plan_slots: Record<string, string>;
  collaboration: Record<string, unknown>;
  tools: Array<Record<string, unknown>>;
  tested_with: Record<string, unknown>;
  known_limitations: string[];
}

import { escalationOperatorCatalogue } from "./collaboration.js";

export function buildServerCard(): ServerCard {
  return {
    server: {
      name: "smart-calendar",
      namespace: "calendar_",
      description: "多租戶智慧日曆：查行程、找空檔、查團隊成員、排會（需確認）",
      protocol: "MCP",
      naming_policy:
        "新工具一律以 calendar_ 前綴命名，避免與其他 server 撞名（無前綴的舊名稱保留相容但已 deprecated）",
    },
    privacy: {
      visibility: "requester_own_and_participating_events_only",
      enforced_at: "server (PostgreSQL RLS + 個人隔離查詢)",
      note:
        "呼叫端的推理能力與此邊界無關：即使是最強的模型，也只能取得授權使用者本人的行程" +
        "以及本人受邀的共同行程；其他成員的私人行程永不外流。",
      writes: {
        allowed_via_query_tool: false,
        reason: "改期／取消／回覆邀請一律需使用者本人於站內確認",
        scheduling: "calendar_query 不建立事件；排程請用 delegate_complex_scheduling，且需 confirm=true 才落實",
      },
    },
    // 每個查詢意圖「回什麼」必須寫清楚。實測 minimax-m2.1 因為不知道 event_detail 會回
    // 與會者名單，直接回答「無法確認參與者」；也因為不知道 list_pending 存在而自創參數。
    query_intents: {
      list_events: "時間窗內的行程清單（標題／起訖／地點）",
      count_events: "時間窗內的行程數量",
      find_free: "可用空檔；未指定 duration_minutes 時回合併後的連續區間",
      list_pending: "別人發起、還在等我回覆的邀請",
      list_members: "團隊成員名單與人數",
      next_event: "從現在起最近一筆",
      event_detail: "單一行程完整細節，含 attendees 與會者名單、duration_minutes、location、description",
      search_events: "依關鍵字找行程；filter_keyword 同時比對標題與地點",
      events_with_person: "我與某人的共同行程",
      compare_load: "兩個期間的忙碌程度對比",
      stats: "期間內統計分布（最忙星期幾、時段分布）",
    },
    plan_slots: {
      time: "anchor（today/tomorrow/day_after_tomorrow/this_week/next_week/last_week/this_month/next_month/none）、weekday_from/to、或 date_from/date_to（絕對日期 yyyy-mm-dd，要查某一天用這個）",
      filters: "daypart、filter_keyword（標題或地點）、group_name、person_name、duration_minutes、order、search_range",
    },
    collaboration: {
      why:
        "本地路由使用 14B 模型，理解能力有限；呼叫端若具備更強的理解能力，" +
        "應自行完成理解並把結果送進來，避免「強模型把問題交給弱模型重新理解一次」的雙重損失。",
      modes: [
        {
          mode: "question + detail=brief",
          who: "能力有限的呼叫端",
          behavior: "本地 14B 完整負責理解與措辭，回一句自然語言",
          local_model_calls: "1–3",
        },
        {
          mode: "question + detail=evidence",
          who: "強模型，想沿用本地理解但要自行覆核",
          behavior: "附上決策依據與 uncertain 標記（候選重排、語法補抽等推測步驟）",
          local_model_calls: "1–3",
        },
        {
          mode: "subtasks[] + detail=evidence",
          who: "強模型，已自行拆解複合請求",
          behavior: "跳過本地 Planner，各子請求並行執行",
          local_model_calls: "每個子請求 1–2（省下 Planner 那一次與其誤判風險）",
        },
        {
          mode: "plan{} + detail=structured|evidence",
          who: "強模型，已自行完成意圖與槽位判斷",
          behavior: "本地完全不呼叫語言模型，只做資料查詢與政策檢查",
          local_model_calls: "0",
        },
      ],
      recommended_for_strong_agents: "detail='auto'（協作模式，本地先做能力自評）；已明確知道要查什麼時用 plan{}",
      escalation_policy: {
        what: "detail='auto' 時本地會自評能不能答；不能答就回 kind='escalate' 並附上所需事實",
        why:
          "本地工具面沒有『對查詢結果再做運算』的能力（聚合、極值、兩兩比對、分組比較）。" +
          "這是能力缺口而非信心問題，因此不先跑模型，直接備好事實交給呼叫端推理。",
        triggers: escalationOperatorCatalogue(),
        also_escalates_when: "本地已回答但過程含推測步驟（候選重排、語法補抽）或需要追問",
        method_basis:
          "SWARM-LLM (IEEE VTC2026-Spring)：以輕量難度／安全訊號做本地→雲端的門檻式升級；" +
          "其實測顯示選擇性升級可把困難題正確率從 0.00 提升到 0.15，同時雲端曝露率降低 72%。" +
          "本實作刻意不使用小模型自評信心（arXiv:2504.04718、EMNLP 2025 指出其不可靠），" +
          "改用確定性的運算子偵測與執行過程的推測標記。",
      },
    },
    tools: [
      {
        name: "calendar_query",
        kind: "read-only",
        scope_required: "event.read",
        typical_response_tokens: { brief: "60–300", structured: "200–900", evidence: "400–1500" },
        hard_caps: { page_size_max: 50, message_chars_max: 2000 },
        measured_latency_ms: {
          // 313 題回歸套件實測（median / p90）
          question_deterministic_fast_path: { median: 15, note: "純時間詞查詢，完全不呼叫模型" },
          question_single: { median: 3731, p90: 5402 },
          question_compound: { median: 8146, p90: 9818 },
          plan: { median: 120, note: "呼叫端已完成理解，本地零模型呼叫" },
        },
        pagination: true,
      },
      {
        name: "calendar_find_slots",
        aliases: ["find_available_time_slots"],
        kind: "read-only",
        scope_required: "availability.read",
        typical_response_tokens: { default: "50–400" },
      },
      {
        name: "delegate_complex_scheduling",
        kind: "write (需 confirm)",
        scope_required: "event.write",
        note: "未帶 confirm=true 只回方案預覽，不寫入",
        measured_latency_ms: { median: 6000, note: "多節點委員會（coordinator → negotiator → resourceManager）" },
      },
    ],
    tested_with: {
      local_model: process.env.LLM_MODEL ?? "qwen3:14b",
      embedding_model: process.env.INAPP_EMBED_MODEL ?? "embeddinggemma:latest",
      regression_suite: {
        questions: 313,
        pass_rate: "313/313",
        privacy_leaks: 0,
        note: "題庫與逐版結果在 repo 的 eval/ 目錄，可重跑比對",
      },
      external_clients: ["MCP stdio", "MCP HTTP (streamable)"],
    },
    known_limitations: [
      "本地 14B 在多步推理、跨人協調、需要判斷取捨的問題上表現有限——這正是建議改用 plan/subtasks 的情境。",
      "detail=brief 的措辭由本地模型產生，可能比呼叫端自己組裝的答案粗略。",
      "跨成員的忙碌比較只能在授權使用者可見範圍內進行，無法看到他人私人行程的細節。",
      "回應以分頁提供；一次要取完整大量資料請自行翻頁，不要期待單次回應包含全部結果。",
    ],
  };
}
