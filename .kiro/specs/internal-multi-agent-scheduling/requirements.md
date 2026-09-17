# 內部多智能體協作系統 — Requirements

> 在既有多租戶智慧日曆後端上，以 **LangGraph.js** 建立「內部多智能體協作系統（Multi-Agent System）」，
> 降低外部 Agent 的認知負擔：對外只暴露一個高階 MCP Tool，內部由一組專家 Agent 自行討論、
> 呼叫既有 Service 層完成複雜排程（含公務車特殊業務邏輯）。
>
> 設計原則：**不新增旁路**。所有落實資料的動作仍走既有 Service 層與同一條授權鏈
> （JWT → guardTool → PDP(OPA) → RLS），Agent 只是「編排者」，不是新的信任邊界。

## 詞彙與現況對齊（重要）

本 spec 撰寫前已核對現有程式碼，敘述中的服務名稱對應如下真實介面：

| 敘述中的名稱 | 真實介面 | 位置 |
| --- | --- | --- |
| `find_optimal_time_slots` 服務 | `computeAvailability()` / `findSlots()` | `apps/api/src/scheduling/availability.ts`、`freebusy.ts` |
| 現有 MCP 排程 tool | `find_available_time_slots` | `apps/api/src/mcp/tools.ts` |
| 資源預訂 | `bookResource()`（`EXCLUDE USING gist` 防重疊） | `apps/api/src/resources/service.ts` |
| MCP 授權守門 | `guardTool()` + `TOOL_SCOPE` | `apps/api/src/mcp/guard.ts` |
| 二次確認模式 | `book_resource` 未帶 `confirm=true` → `confirmation_required` | `apps/api/src/mcp/tools.ts` |
| NL 時間解析 | `parseEventFromText()` / `RuleBasedParser`（中英相對時間、星期、DST 換算） | `packages/shared/src/nlp.ts` |
| 事件參與者 | `event_participants` 表（`computeAvailability` 的 member 過濾來源） | `apps/api/src/db/migrate.ts` |

### 核對後修正的關鍵假設（重要）
- **公務車「前後各 15 分鐘 buffer」尚未存在**，屬本 spec 新增業務邏輯（REQ-4）。
- **`resources.type` 的 DB CHECK 僅允許 `'room' | 'equipment'`**。因此「vehicle（公務車）」**不是**新的 DB type，
  MVP 純屬應用層概念：以 `type='equipment'` + 名稱/關鍵字判定，不改 schema。
- **`createEvent()` 不寫參與者**，`computeAvailability()` 的 `member_ids` 過濾查的是 `event_participants`。
  委員會落實時**必須額外寫入 `event_participants`**，否則 free/busy 過濾失準（見 REQ-3 落實流程）。
- **名字→member 目前無查詢介面**：schema 有 `memberships` + `users.display_name`，但無「列成員」函式。
  需**新增** `listMembers(workspaceId)` 供 Coordinator 做名字比對（REQ-2）。
- **時間解析不重造輪子**：Coordinator 重用既有 `parseEventFromText()`（已處理中英相對時間與 DST），
  LLM/規則只負責 parser 未涵蓋的實體（attendees、resources）。
- **`resource_bookings` 的 `EXCLUDE gist` 用半開區間 `tstzrange(start,end)` `[)`**：相鄰貼齊不算重疊，
  buffer 邊界測試斷言需對齊此語意（REQ-4）。

---

## Requirement 1：引入 LangGraph.js 基礎建設

**User Story**：作為後端工程師，我要在 API 專案引入 LangGraph.js，
以便用 `StateGraph` 編排多個內部 Agent 節點。

### 驗收準則
1. `apps/api` 安裝 `@langchain/core`、`@langchain/langgraph`，以及一個模型 provider 套件
   （預設 `@langchain/openai`，允許以介面替換）。版本以 exact / pinned 記錄於 `package.json`。
2. 在 `apps/api/src/agents/` 下建立基於 `StateGraph` 的工作流骨架，狀態型別集中定義、可測試。
3. 模型 provider 以環境變數配置（`OPENAI_API_KEY`、`LLM_MODEL`、`LLM_BASE_URL?`）。
   金鑰缺失時不得於載入期崩潰；僅在實際呼叫 LLM 時 fail-closed 並回可讀錯誤。
4. 圖的建構與節點函式需可在**不呼叫真實 LLM**下被單元測試（模型以介面注入，測試可 mock）。

---

## Requirement 2：日曆專家委員會（The Calendar Committee）

**User Story**：作為系統，我要一個由三個節點組成的 LangGraph 工作流，
把一段模糊的自然語言排程需求，逐步收斂成一次可執行的預約（或談判選項）。

### 三個節點（Nodes / Agents）

1. **Coordinator Agent**
   - 接收自然語言輸入，解析出狀態 `{ attendees, resources, timeframe }`。
   - **時間解析重用既有 `parseEventFromText()`**（已含中英相對時間、星期、DST 換算），
     取得 `timeframe`；LLM/規則只補 parser 未涵蓋的 `attendees`、`resources` 實體。
   - `attendees`：以 **新增的 `listMembers(workspaceId)`**（回 `{membership_id, display_name}`）做名字比對；
     找不到唯一對應 → `needs_clarification`（不臆測）。
   - `resources`：資源需求（例如「公務車」→ `type=equipment` + 名稱關鍵字；見 REQ-4 判定）。
   - `timeframe`：`{ from_utc, to_utc, duration_minutes }`（相對詞如「下週三下午」由 parser 以 `reference_now_utc` 解析）。
   - 解析不足以繼續時，需輸出「需澄清」狀態而非臆測。

2. **Negotiator Agent**
   - 呼叫內部空檔服務（`computeAvailability()` / `findSlots()`）取得候選時段。
   - 若與既有事件/資源衝突，計算並提出**最佳 3 個備案**（沿用 `findSlots` 評分：越早、對齊整/半點加分）。
   - 產出「建議時段」或「談判選項（最多 3）」。

3. **Resource Manager Agent**
   - 檢查公務車（及同類需交接的資源）特殊業務邏輯：
     在預約時段**前後各加 15 分鐘 Buffer Time**，避免連續借車交接不及（詳見 REQ-4）。
   - 以「含 buffer 的時段」做資源可用性判定；buffer 命中他人預約 → 視為該時段不可用，退回 Negotiator 重議。

### 驗收準則
1. 工作流以 `StateGraph` 定義，節點間以共享 State 傳遞，流轉可決定性地測試。
2. 從「模糊 NL」→「Coordinator 解析」→「Negotiator 找時段」→「Resource Manager 套 buffer 檢查」
   →（成功）落實預約 /（衝突）回談判選項，形成完整、可觀測的路徑。
3. 任一節點失敗（解析不足、無可用時段、LLM 不可用）時，圖以明確終止狀態結束，不得無限迴圈。

---

## Requirement 3：開放高階 MCP Tool `delegate_complex_scheduling`

**User Story**：作為外部 AI Agent，我只想描述一個複雜排程任務，
不必自己一步步呼叫 CRUD tools，由內部委員會替我完成。

### 介面
- **Input**：`task_description`（字串）。
  例：「幫我跟 Bob 借一輛公務車去拜訪客戶，時間在下週三下午」。
  可選：`reference_now_utc`、`default_timezone`（相對時間解析用）。
- **Behavior**：在後端觸發 REQ-2 的 LangGraph 工作流；內部多個 Agent 討論並呼叫既有 Service 層。
- **Output**（三種終態擇一）：
  - `booked`：最終成功預約結果（event + resource booking）。
  - `needs_decision`：需人類決策的談判選項（最多 3），沿用既有 `confirmation_required` 精神。
  - `needs_clarification` / `error`：資訊不足或不可執行，附可讀原因。

### 驗收準則（零信任，沿用既有鏈）
1. 新 tool 經 `guardTool()` 走同一授權鏈，並在 `TOOL_SCOPE` 註冊所需 scope。
   高階 tool 會觸發多種底層動作，需具備其**全部**必要 scope（`event.write` **且** `resource.book`；
   讀取階段另需 `availability.read`）。任一缺失 → `insufficient_scope`，全程不落實。
2. `workspace` / `sub` 一律來自 token，**不得**由 `task_description` 或圖內狀態覆寫（ZT-5）。
3. 內部各節點對底層 Service 的呼叫，仍受 RLS 與 PDP 約束；Agent 不得直接觸碰 DB（ZT-3）。
4. 被撤銷的 agent（Redis 黑名單）於此 tool 呼叫即時 fail-closed。
5. 所有實際落實動作寫 `audit_log`（`actor_type=agent`, `source=agent`），與現有 MCP tool 一致（MCP-13）。
6. 破壞性/佔用型結果（實際 booking）預設需二次確認：未帶 `confirm=true` 時回 `needs_decision`/預覽，
   帶 `confirm=true` 才落實（對齊既有 `book_resource` 的 MCP-12 行為）。
7. **落實需寫 `event_participants`**：帶 `confirm=true` 落實時，除 `createEvent` 外，
   須為每個解析出的 attendee 建立 `event_participants` 列，否則後續 free/busy 過濾與提醒失準。
8. **落實原子性**：`createEvent` + `event_participants` + `bookResource` 應在**同一 `withWorkspace` 交易**內完成；
   任一步失敗則整筆 rollback，不留半套（取代先前「回 error+event_id」的 MVP 折衷）。

---

## Requirement 4：公務車 Buffer Time 業務邏輯

**User Story**：作為車隊管理者，我要公務車預約前後自動保留 15 分鐘交接緩衝，
避免連續借用時來不及交接。

### 驗收準則
1. 對「需交接」資源（預設 `type=equipment` 且標記為 vehicle，或以資源 `availability`/metadata 標記；
   實作策略見 design），可用性判定與衝突偵測皆以 `[start-15m, end+15m]` 的擴張區間為準。
2. buffer 為配置值（預設 15 分鐘，`RESOURCE_HANDOVER_BUFFER_MINUTES`），非硬編碼。
3. 實際寫入 `resource_bookings` 的區間策略需明確且一致（二選一，design 定案並記錄理由）：
   (a) 只存實際使用區間，靠應用層做 buffer 判定；或
   (b) 存含 buffer 的區間，讓 `EXCLUDE USING gist` 直接擋。
4. buffer 邏輯需有針對「相鄰預約剛好落在 buffer 內」的測試（邊界：間隔 14 分鐘應衝突、15 分鐘剛好、16 分鐘可用）。
5. **半開區間語意**：DB `EXCLUDE gist` 用 `tstzrange(start, end)` 為半開 `[)`，相鄰端點貼齊不算重疊。
   測試斷言需對齊：擴張後兩區間端點剛好相接（15 分鐘間隔）視為**不衝突**。

---

## Requirement 5：委員會自動掛提醒（功能 A）

**User Story**：作為使用者，預約成功後希望依資源類型自動獲得合適提醒（公務車會前提醒取車）。

### 驗收準則
1. 落實成功後，Resource Manager 依資源類型自動建立 `event_reminders`：
   - 需交接資源（公務車）：會前 30 分鐘 `channel='email'`（可配置 `VEHICLE_REMINDER_LEAD_MINUTES=30`）。
   - 一般事件：沿用預設或不加（不重複既有 reminder 設定）。
2. 建立提醒仍在同一落實交易內；重用既有 reminders service，不繞過 BullMQ 排程。
3. `confirm=false`（僅預覽）時不建立提醒。

## Requirement 6：dry-run / explain 模式（功能 B）

**User Story**：作為開發者/外部 Agent，我想看委員會的推理軌跡而不落實，以便除錯與信任建立。

### 驗收準則
1. tool 支援 `explain=true`：回傳各節點決策軌跡（Coordinator 解析結果、Negotiator 候選與評分、
   Resource Manager buffer 判定），`status` 不進入 `booked`，**絕不寫 DB**。
2. 軌跡不得洩漏跨 workspace 或他人 private 事件內容（只給 free/busy 等級資訊，對齊 UI-6/§10）。

## Requirement 7：委員會決策寫稽核（功能 D）

**User Story**：作為合規/管理者，我要能追溯 AI 委員會「為何這樣排」，不只落實動作。

### 驗收準則
1. 除既有落實動作稽核外，委員會關鍵決策寫 `audit_log`：`action='committee.decision'`，
   `metadata` 含 `{ node, task_description(截斷), timeframe, chosen_slot, options }`。
2. 沿用既有 `writeAudit`（`actor_type=agent`, `agent_id=sub`）；寫入失敗不阻斷主流程。
3. 稽核內容同樣不得含跨 workspace / private 明細。

---

## 延伸（第二階段，本 spec 記錄不強制實作）

### 延伸 C：談判選項一鍵確認（option_token）
`needs_decision` 回傳每個 option 帶 `option_token`（簽章、含 workspace/attendees/resource/slot、短 TTL）；
人類選定後 re-call `confirm=true` + `option_token` 直接落實，免重跑整個圖。降低延遲與 LLM 成本。

### 延伸 E：衝突通知 webhook
委員會判定 `needs_decision` 時觸發既有 webhook。**需擴充** `packages/shared` 的 `WebhookInput.events` enum
（現為固定清單，無 `scheduling.needs_decision`）與 webhook 派送點。屬跨模組改動，故列延伸。

---


1. `apps/api/src/agents/calendar_graph.ts`：LangGraph `StateGraph` 邏輯。
2. 三個 Agent（Coordinator / Negotiator / Resource Manager）的 Prompt 與執行邏輯。
3. 註冊 MCP tool `delegate_complex_scheduling`（`tools.ts` + `TOOL_SCOPE`）。
4. Jest（或現有測試框架）測試：以一段模糊 NL 需求，驗證 Graph 正確流轉並完成公務車預約
   （含衝突→備案、buffer 邊界）。

## 非目標（Out of Scope）
- 對外 MCP 傳輸層（Streamable HTTP / gateway）與 OAuth 2.1 consent（見主 spec 8.3/8.8）。
- 真實 LLM 供應商選型與成本最佳化；本 spec 只要求 provider 可插拔且可 mock。
- 前端呈現談判選項的 UI（可後續於主 spec frontend 補）。
