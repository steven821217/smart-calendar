# 內部多智能體協作系統 — Tasks

> 依賴既有：`scheduling/availability.ts`、`scheduling/freebusy.ts`、`resources/service.ts`、
> `events/service.ts`、`mcp/guard.ts`、`mcp/tools.ts`。所有落實動作沿用既有 Service 層與授權鏈。

## 階段 A — 基礎建設（REQ-1）
- [x] A.1 於 `apps/api` 安裝並 pin：`@langchain/core`、`@langchain/langgraph`、`@langchain/openai`。
- [x] A.2 `.env.example` 新增：`OPENAI_API_KEY=`、`LLM_MODEL=gpt-4o-mini`、`LLM_BASE_URL=`（選填）、
      `RESOURCE_HANDOVER_BUFFER_MINUTES=15`、`RESOURCE_VEHICLE_TYPES=equipment`、
      `VEHICLE_REMINDER_LEAD_MINUTES=30`（功能 A）。
- [x] A.3 `src/agents/llm.ts`：`ChatModel` 介面 + `makeChatModel()`（讀 env，包 openai；金鑰缺失延後到呼叫才報錯）。
- [x] A.4 `src/agents/state.ts`：`CommitteeState` 型別（含 `explain`/`trace`/`actual_*`）與 LangGraph channels/reducers。
- [x] A.5 新增 `listMembers(workspaceId)`（回 `{membership_id, display_name}`；`withWorkspace`，RLS 兜底）供名字比對。

## 階段 B — 委員會工作流（REQ-2）
- [x] B.1 `src/agents/prompts.ts`：三節點的 system/human prompt（僅抽 attendees/resources 實體）。
- [x] B.2 `src/agents/nodes/coordinator.ts`：**時間重用 `parseEventFromText()`**；LLM 抽 attendees/resources；
      名字→member 以 `listMembers` 唯一比對，否則 `needs_clarification`。
- [x] B.3 `src/agents/nodes/negotiator.ts`：接 `computeAvailability`/`findSlots`；產首選 + 最多 3 備案。
- [x] B.4 `src/agents/nodes/resourceManager.ts`：套 handover buffer（半開區間語意）判定可用性；不可用退回 negotiator（一輪）。
- [x] B.5 `src/agents/calendar_graph.ts`：`StateGraph` 組裝 + `runCalendarCommittee(ctx, input, { model? })`；
      終止保證（無無限迴圈），統一 `status` 終態。

## 階段 C — Buffer + 原子落實（REQ-4 / REQ-3.7/3.8）
- [x] C.1 於 resource 判定加入「需交接資源」辨識（type + 名稱/metadata；可配置 `RESOURCE_VEHICLE_TYPES`）。
- [x] C.2 落實時對需交接資源將寫入區間外擴 buffer（策略 b），並在回傳中同時給 `actual_usage`。
- [x] C.3 讀取/顯示時扣回 buffer 的 helper（供後續 API/前端使用）。
- [x] C.4 **`commitSchedulingPlan(ctx, plan)`**（`src/agents/service.ts`）：單一 `withWorkspace` 交易內
      insert event → `event_participants` → booking（含 buffer）→ reminders；任一步失敗整筆 rollback。

## 階段 C2 — 功能 A/B/D
- [x] A功能 委員會自動提醒：`commitSchedulingPlan` 對公務車建 `event_reminders`（會前 `VEHICLE_REMINDER_LEAD_MINUTES`）。
- [x] B功能 explain/dry-run：tool 參數 `explain=true` → 各節點寫 `trace`，短路落實，絕不寫 DB；trace 不含 private 明細。
- [x] D功能 決策稽核：各節點關鍵決策 `writeAudit(action='committee.decision', metadata={node,timeframe,chosen_slot,options})`。

## 階段 D — MCP Tool（REQ-3）
- [x] D.1 `mcp/guard.ts`：`TOOL_SCOPE` 新增 `delegate_complex_scheduling: "event.write"`。
- [x] D.2 `mcp/tools.ts`：`toolDelegateComplexScheduling(auth, args)`：
      - `guardTool` 進入；
      - 聚合斷言 scope 含 `availability.read`+`event.write`+`resource.book`，否則 `insufficient_scope`；
      - 呼叫 `runCalendarCommittee`；依 `status` 對映輸出（booked/needs_decision/needs_clarification/error）；
      - `confirm` 語意：false → 只回 needs_decision/預覽，不落實。
- [x] D.3 在 MCP tool 分派表註冊此 tool（對齊既有註冊點）。

## 階段 E — 測試（REQ-2/3/4 Deliverable 4）
- [x] E.1 單元：coordinator 以 stub model 解析固定 NL → 正確 state；解析不足→needs_clarification。
- [x] E.2 單元：negotiator 對造構 busy 集合 → 首選 + 3 備案（分數排序）。
- [x] E.3 單元：buffer 邊界（間隔 14/15/16 分鐘：衝突/剛好/可用）。
- [x] E.4 整合：以 stub model 餵「跟 Bob 借公務車，下週三下午」→ Graph 流轉 → confirm=true 完成預約；
      驗證 event.source='agent'、**寫了 `event_participants`**、booking 區間含 buffer、
      **自動掛了公務車提醒**、audit_log 有落實紀錄 + `committee.decision` 紀錄。
- [x] E.5 零信任：缺 scope→insufficient_scope；被撤銷 agent→forbidden；NL 內夾帶他 workspace 字樣不生效。
- [x] E.6 終止：LLM stub 拋錯 → status=error，圖不掛死。
- [x] E.7 原子性：模擬 booking 競態失敗 → 整筆 rollback，事件/參與者/提醒皆無殘留。
- [x] E.8 explain：`explain=true` 回 `trace` 且 DB 無任何寫入。

## 延伸（第二階段，見 requirements 延伸 C/E）
- [x] X.1（C）`needs_decision` option 帶簽章 `option_token`；confirm+token 直接落實，免重跑圖。
- [x] X.2（E）擴充 `WebhookInput.events` enum 加 `scheduling.needs_decision` + 派送點；委員會判談判時觸發 webhook。

## 驗收
- 全部既有 56 tests 不回歸；新增測試綠燈。
- `pnpm --filter @scal/api test` 與 `tsc` 通過。
- README「尚未實作」區更新，移除或標記本功能為已完成階段。

## 風險 / 待決
- LLM 供應商與金鑰：CI 無金鑰 → 測試一律走 stub model，不打真實 API。
- 名字→member 解析在無成員目錄查詢 API 時的策略（MVP：以 workspace memberships 直查；找不到唯一 → 澄清）。
- 「event 已建、booking 失敗」的補償（MVP 回 error+event_id；後續可包成交易或 saga）。
