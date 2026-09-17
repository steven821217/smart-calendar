**Role & Task**
你是本專案的 AI 架構師。我們的 LangGraph「專家委員會」已經大獲成功，現在我們要引入「團隊群組 (Groups) 與非同步委派審批」機制，讓 Agent 成為真正的虛擬團隊特助。

**Requirement 1: 實作 Group 資料模型與 RSVP 狀態 (Database & Schema)**
1. **團隊結構**：新增 `tbl_groups` 與 `tbl_group_members` (欄位需包含 `group_id`, `user_id`, `role: 'leader' | 'member'`)，並撰寫對應的 DB Migration。
2. **RSVP 狀態**：擴充現有的會議參與者資料表 (例如 `tbl_event_participants`)，加入 `rsvp_status` 欄位 (預設值為 `pending`，可為 `accepted` 或 `declined`)。
3. **資安規則 (OPA)**：更新 `authz.rego`，允許 Leader 讀取其 Member 的 `availability.read`，但不能不經同意直接強佔時間（必須透過 pending 狀態）。

**Requirement 2: 升級 LangGraph 專家委員會 (Context-Awareness)**
請修改 `apps/api/src/agents/` 底下的邏輯：
1. **語意解析升級 (Coordinator Node)**：當輸入文字包含「我的組員」、「我的團隊」或「某個 Member」時，Coordinator 必須能夠呼叫資料庫，將這些模糊代名詞**解析 (Resolve) 為真實的 User IDs**，再往下傳遞給 Negotiator。
2. **非同步委派流 (Negotiator / Resource Manager Node)**：當 Leader 幫 Member 安排任務/會議時，Agent 計算出最佳時間後，將該 Member 的 `rsvp_status` 設為 `pending`。

**Requirement 3: 任務派發與一鍵同意機制 (Delegation & Option Token)**
1. **復用 Option Token**：利用我們上一階段實作的 `option_token` 機制。當 Agent 建立了一個 `pending` 的事件給 Member 時，系統自動為該 Member 產生專屬的 `option_token`，並觸發 Webhook 或 Notification 事件（模擬在 Member 端跳出通知）。
2. **API 擴充**：新增或擴充 RSVP API (例如 `POST /v1/events/:id/rsvp`)，讓 Member 可以使用 `option_token` 進行 `accept` (同意，將事件正式排入行事曆) 或 `decline` (拒絕)。

**Deliverables (請逐步實作並自行除錯，維持 All Green 狀態)**
1. 完成 DB Migrations 與 Schema 更新。
2. 更新 Coordinator 讓 LLM 具備「查詢團隊成員」的 Context 認知能力。
3. 實作 Leader 派發任務 -> 產生 Pending Event -> 觸發 Member Option Token -> Member 同意的完整 API 閉環。
4. 撰寫至少 5 個整合測試，模擬「Leader 叫 Agent 幫團隊排會 -> 系統解析出 3 個 Members 產生 Pending 邀請 -> Member 呼叫 API 同意」的完整情境。

---

## 實作狀態（已完成 ✅）

| Requirement | 落實位置 |
| --- | --- |
| R1.1 Group 資料模型 | `apps/api/src/db/migrate.ts`：`groups` / `group_members`（`role: leader\|member`）+ RLS（12 表） |
| R1.2 RSVP 狀態 | `event_participants.rsvp_status`（`pending`\|`accepted`\|`declined`，預設 `pending`） |
| R1.3 資安規則 (OPA) | `policies/authz.rego`：`group.read` / `group.manage`；leader（scheduler）可 `availability.read`，但強佔由 pending+同意流程保證 |
| R2.1 Coordinator 代名詞解析 | `apps/api/src/agents/nodes/coordinator.ts`：偵測「我的組員/團隊/team」→ `resolveTeamMemberships()` 解析真實 membership id |
| R2.2 非同步委派 | `apps/api/src/agents/service.ts` `commitSchedulingPlan`：委派型 attendee 落實為 `rsvp_status='pending'` |
| R3.1 Option Token + 通知 | `agents/option_token.ts` `signRsvpToken/verifyRsvpToken`；落實時每個 pending member 產 `rsvp_token` + 發 `scheduling.rsvp_pending` webhook |
| R3.2 RSVP API | `POST /v1/events/:id/rsvp`（token 自證、免登入）→ `events/rsvp_service.ts` `applyRsvp` |
| 前端 UI | `apps/web`：`GroupsPage`（群組/成員管理）、`RsvpPage`（`#/rsvp?event=&token=` 一鍵回覆）、AppShell 導覽 |
| 測試 | `apps/api/test/team-groups.test.ts`（6 tests：REST 授權、委派閉環、accept/decline、token 綁定/竄改）；全套 134 綠燈 |

### 服務層 API 摘要
- 群組：`GET/POST /v1/groups`、`DELETE /v1/groups/:id`、`GET/POST /v1/groups/:id/members`、`DELETE /v1/groups/:id/members/:userId`、`GET /v1/members`。
- RSVP：`POST /v1/events/:id/rsvp`（body：`{ option_token, decision: "accept"|"decline" }`）。token 綁 `workspace/event/member`（ZT-5），路徑 event 與 token 不符 → 403，驗章失敗 → 401。
- 落實原子性沿用既有單一 `withWorkspace` 交易；委派成員 `pending`、非委派 `accepted`。
