# 內部多智能體協作系統 — Design

## 1. 架構總覽

```
外部 Agent (M2M JWT + scopes)
        │  MCP: delegate_complex_scheduling(task_description, …)
        ▼
   guardTool()  ──►  PDP(OPA)  （scope ∩ role，workspace 來自 token）
        │  (通過 → AuthContext ctx)
        ▼
  runCalendarCommittee(ctx, input)          ← apps/api/src/agents/calendar_graph.ts
        │  StateGraph
        ├─ coordinator   ── LLM 解析 → { attendees, resources, timeframe }
        ├─ negotiator    ── computeAvailability()/findSlots() → 候選 + 備案
        └─ resourceMgr   ── 套用 handover buffer → 可用性判定 → 落實 or 談判
        ▼
   既有 Service 層（createEvent / bookResource …） ─► RLS ─► Postgres
        ▼
   audit_log（actor_type=agent, source=agent）
```

**信任邊界只有一個**：`guardTool()`。圖與 LLM 都在該邊界之後執行，且圖內對底層的每次呼叫
仍受 RLS/PDP 約束。LLM 的輸出被視為**不可信建議**：任何落實動作前，時段/資源/權限都由既有
Service 與 DB 約束（`EXCLUDE gist`、RLS、PDP）再驗證一次。

## 2. 目錄與模組

```
apps/api/src/agents/
  calendar_graph.ts     # StateGraph 組裝 + runCalendarCommittee(ctx, input)
  state.ts              # CommitteeState 型別 + reducer/channels
  llm.ts                # 模型 provider 工廠（介面注入，可 mock）
  nodes/
    coordinator.ts      # NL → { attendees, resources, timeframe } | needs_clarification
    negotiator.ts       # 候選時段 + 最多 3 備案
    resourceManager.ts  # handover buffer + 可用性 + 落實/談判
  prompts.ts            # 三個節點的 system/human prompt 樣板
  (既有) service.ts routes.ts  # 不動：agent 授權/撤銷管理
```

MCP 註冊：`apps/api/src/mcp/tools.ts` 新增 `toolDelegateComplexScheduling()`；
`apps/api/src/mcp/guard.ts` 的 `TOOL_SCOPE` 新增條目。

## 3. State 定義（`state.ts`）

```ts
export type Timeframe = { from_utc: string; to_utc: string; duration_minutes: number };
export type ResourceNeed = { kind: "vehicle" | "room" | "equipment" | "named"; ref?: string };
export type NegotiationOption = { start_utc: string; end_utc: string; score: number };

export interface CommitteeState {
  // 輸入
  task_description: string;
  reference_now_utc: string;
  default_timezone: string;
  // Coordinator 產出
  attendees: string[];             // membership id
  resources: ResourceNeed[];
  timeframe: Timeframe | null;
  // Negotiator 產出
  candidate?: NegotiationOption;
  options: NegotiationOption[];     // 最多 3
  // Resource Manager 產出
  booking_plan?: { resource_id: string; start_utc: string; end_utc: string; // 含 buffer 的寫入區間
                   actual_start_utc: string; actual_end_utc: string };       // 扣回 buffer 的使用時段
  // 觀測性（功能 B/D）
  explain: boolean;                 // dry-run：只回軌跡不落實
  trace: Array<{ node: string; note: string; data?: unknown }>;  // 各節點決策軌跡
  // 終態
  status: "pending" | "needs_clarification" | "needs_decision" | "booked" | "error";
  message?: string;                 // 給人類的可讀說明
  result?: unknown;                 // booked 時的 event + booking
}
```

State 以 LangGraph channels 定義；陣列欄位用「覆寫」reducer（節點各自負責產出完整值），
避免累加造成重複。

## 4. 節點行為

### 4.1 Coordinator（`nodes/coordinator.ts`）
- 輸入 `task_description` + `reference_now_utc` + `default_timezone`。
- **時間 (`timeframe`) 重用既有 `parseEventFromText()`**（`packages/shared/src/nlp.ts`，已處理中英相對時間、
  星期、DST），取 `start_utc`/`end_utc`/推得 `duration_minutes`；LLM 只補 parser 未涵蓋的實體。
- **attendees / resources 以 LLM structured output 抽取**（或先規則後 LLM 補強）：
  - 名字→membership：呼叫**新增的 `listMembers(workspaceId)`**（回 `[{membership_id, display_name}]`），
    做唯一比對；找不到唯一對應 → `needs_clarification`（不臆測）。
  - resource kind=vehicle 為應用層概念（DB 無此 type），對映到 `type='equipment'` + 名稱關鍵字。
- 缺關鍵欄位（無 timeframe、無可解析 attendee）→ 設 `status=needs_clarification` 並帶原因，終止圖。
- **可測試性**：LLM 以 `llm.ts` 的介面注入；測試提供 stub 直接回結構化解析結果，不呼叫真實模型。
  時間解析走既有 parser（純函式），測試不需 mock。

> **新增查詢** `listMembers(workspaceId)`（放 `src/agents/service.ts` 或新 `memberships/service.ts`）：
> `SELECT m.id AS membership_id, u.display_name FROM memberships m JOIN users u ON u.id=m.user_id`
> （`withWorkspace` 交易內，RLS 兜底）。

### 4.2 Negotiator（`nodes/negotiator.ts`）
- 用 `computeAvailability(ctx.workspace, { from_utc, to_utc, duration_minutes, member_ids: attendees })`
  取得候選 slots。
- 首選 = 分數最高者 → 寫入 `candidate`。
- 供 Resource Manager 判定；若 Resource Manager 退回（buffer/資源衝突），
  以 `findSlots(...maxResults=3)` 產生 `options`（最多 3），設 `status=needs_decision`。
- 完全無候選 → `status=error`（窗口內無空檔），帶可讀訊息。

### 4.3 Resource Manager（`nodes/resourceManager.ts`）
- 對每個 `ResourceNeed`：
  - 解析為具體 `resource_id`（具名 → 直接；kind=vehicle/equipment → 查 workspace 內符合者，
    多台則挑候選時段可用的第一台）。
  - **Buffer 判定**：以擴張區間 `[start - B, end + B]`（B=`RESOURCE_HANDOVER_BUFFER_MINUTES`，預設 15）
    對 `resource_bookings` 做重疊檢查。
- 全部資源在候選時段（含 buffer）可用 → 產出 `booking_plan`，進入落實。
- 任一資源被 buffer/既有預約擋住 → 退回 Negotiator 要 3 備案（`needs_decision`）。

### 4.4 落實（confirm 分支）
- `delegate_complex_scheduling` 未帶 `confirm=true`（或 `explain=true`）：即使找到可行 `booking_plan`，
  也回 `needs_decision` + 預覽（對齊 `book_resource` MCP-12），**不寫 DB**。
- 帶 `confirm=true`：在**單一 `withWorkspace(ctx.workspace)` 交易**內依序完成（REQ-3.8 原子性）：
  1. `createEvent(...)` → 取得 `event_id`（`created_by: ctx.sub`, `source: "agent"`）。
  2. 為每個 attendee 寫入 `event_participants`（REQ-3.7）。
  3. `bookResource(...)`：需交接資源以「含 buffer」的擴張區間寫入（見 §5），讓 `EXCLUDE gist` 成為最終防線。
  4. （功能 A）依資源類型建立 `event_reminders`（公務車會前 30 分）。
  - 任一步失敗（如競態 `BookingConflictError`）→ **整筆 rollback**，回 `status=error`，DB 無殘留。
  - 交易需以同一個 `PoolClient` 貫穿，故 design 新增編排函式包住這四步，避免逐一改動既有 service 簽章。

> **新增編排函式** `commitSchedulingPlan(ctx, plan)`（`src/agents/service.ts`）：開一個 `withWorkspace` 交易，
> 內部以同一 client 執行 insert events / participants / booking / reminders，回 `{ event, booking, reminders }`。

## 5. Buffer 落地策略（REQ-4 定案）

**採策略 (b)：`resource_bookings` 寫入「含 buffer」的擴張區間**，理由：
- 讓既有 `EXCLUDE USING gist` 成為權威防線，避免應用層判定與 DB 判定不一致造成競態雙訂。
- 應用層只需負責在建立時把區間擴張，讀取/顯示時再扣回實際使用時段（附 `actual_start_utc`/`actual_end_utc` metadata）。

實作要點：
- `bookResource` 呼叫前，對「需交接」資源把 `start_utc/end_utc` 各外擴 B 分鐘。
- 需交接資源的判定：`resources.type='equipment'` 且名稱/metadata 標記為 vehicle。
  MVP 以 `RESOURCE_VEHICLE_TYPES`（預設含 `equipment`）+ 名稱關鍵字（「公務車」/vehicle）判定；
  design 註記：長期應在 `resources` 加明確 `handover_buffer_minutes` 欄位（migration 後續）。
- 邊界測試：相鄰預約間隔 14 分鐘應衝突、15 分鐘剛好不衝突、16 分鐘可用。

> **半開區間** `tstzrange(start,end)` 為 `[)`：兩擴張區間端點剛好相接（間隔 15 分鐘）**不算重疊**，
> 故「15 分鐘剛好」放行。測試斷言須對齊此語意，勿用閉區間直覺。

## 5a. 功能 A/B/D 設計補充

**A. 自動提醒**：`commitSchedulingPlan` 第 4 步，對需交接資源以既有 reminders service 建
`event_reminders(lead_minutes=VEHICLE_REMINDER_LEAD_MINUTES, channel='email')`，走同一交易與 BullMQ 排程。

**B. explain / dry-run**：tool 參數 `explain=true` → State `explain=true`。所有節點照跑但落實分支被短路，
回 `trace`（各節點 `note`+`data`）。`trace` 僅含 free/busy 等級資訊，不含跨 workspace/private 明細。

**D. 決策稽核**：各節點在關鍵決策點呼叫 `writeAudit(ctx.workspace, { actor_type:'agent', agent_id:ctx.sub,
action:'committee.decision', metadata:{ node, timeframe, chosen_slot, options }})`；
`task_description` 截斷至 200 字。寫入失敗以 try/catch 吞掉，不阻斷主流程（對齊既有 `auditAgent`）。

> 若後續要精準區分「實際佔用」與「buffer」，再加 migration 於 `resource_bookings` 增
> `buffer_minutes` 欄位與生成欄位；MVP 不改 schema。

## 6. 授權與零信任映射

| 關卡 | 機制 |
| --- | --- |
| 進入 | `guardTool(auth, "delegate_complex_scheduling", "event.write", { type:"event" })` |
| Scope | `TOOL_SCOPE` 需 `event.write`；圖內讀取/預訂另經各自動作的 guard/Service，實質要求 `availability.read` + `resource.book` |
| workspace/sub | 僅來自 token；圖內一律用 `ctx.workspace`/`ctx.sub`，忽略 NL 內任何 workspace 字樣（ZT-5） |
| 撤銷 | `isAgentRevoked` 於 `guardTool` 即時檢查（MCP-8） |
| 稽核 | 每次落實 Service 呼叫寫 `audit_log`（既有行為） |

> 註：高階 tool 觸發多動作。實作上有兩種 scope 檢查法，design 採 **(A) 明確聚合檢查**：
> 在 `toolDelegateComplexScheduling` 進入時，除 `guardTool` 外，額外斷言
> `auth.scope` 同時含 `event.write`、`resource.book`、`availability.read`，任一缺 → `insufficient_scope`。
> 這樣外部 agent 得到一致且可預期的失敗，而非走到一半才被某底層動作擋下。

## 7. LLM Provider（`llm.ts`）

```ts
export interface ChatModel { invokeStructured<T>(schema, messages): Promise<T>; }
export function makeChatModel(): ChatModel;  // 讀 env，包 @langchain/openai
```
- 缺 `OPENAI_API_KEY`：`makeChatModel()` 仍可建構，但 `invokeStructured` 呼叫時丟可讀錯誤 → 圖 `status=error`。
- 測試注入 stub `ChatModel`，`runCalendarCommittee(ctx, input, { model })` 允許覆寫，達成不打真實 API。

## 8. 錯誤與終止保證
- 圖有明確終點：每個節點只能導向「下一節點」或「終止」，無循環回邊超過一次（Negotiator↔ResourceMgr 最多重議一輪即收斂為 `needs_decision`）。
- 統一以 `status` 表達終態；`delegate_complex_scheduling` 依 `status` 對映 MCP 回應。
