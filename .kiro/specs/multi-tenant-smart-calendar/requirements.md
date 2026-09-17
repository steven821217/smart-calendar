# 需求規格：多租戶智慧日曆 SaaS 系統

> 狀態：草案 v0.1 · 最後更新 2026-09-14
> 本文件定義「做什麼」與「為什麼」。架構見 `design.md`，安全見 `security.md`，API 見 `api.md`，MCP 見 `mcp.md`，部署見 `infrastructure.md`，任務見 `tasks.md`。

## 1. 產品概述

B2B SaaS 日曆平台，讓多個組織（workspace）在同一套系統上安全隔離地管理各自的行事曆、會議與資源預約，並以智慧排程（衝突偵測、最佳時段建議、自然語言快速建立、AI Agent 自動排程）降低協調成本。

### 目標
- 組織 5 分鐘內完成開通並邀請成員開始排程。
- 跨成員/跨資源的會議安排一次到位。
- 嚴格 workspace 資料隔離，滿足企業安全與合規要求。
- 開放外部 AI Agent 經 MCP 自動化排程，且不繞過任何安全防護。

### 非目標（首版不做）
- 個人 C2C 免費日曆。
- 深度 ML 行為預測（首版用規則/啟發式）。
- 自建視訊會議（改為整合）。

## 2. 角色

| 角色 | 說明 |
|---|---|
| Platform Admin | SaaS 供應商內部：workspace 開通、用量、計費 |
| Workspace Admin | 客戶組織管理者：成員/角色/資源/政策 |
| Scheduler | 代訂會議室與跨人排程者 |
| Member | 一般成員：建立/參加會議 |
| Guest | 無帳號外部受邀者 |
| AI Agent | 外部第三方 agent，經 MCP 代使用者排程 |

## 3. 功能需求（EARS）

### 3.1 Workspace 與帳號
- **REQ-T1** WHEN 平台管理員建立新 workspace，THE 系統 SHALL 佈建隔離資料空間並產生管理員首次登入邀請。
- **REQ-T2** WHILE 使用者已通過身分驗證，THE 系統 SHALL 僅允許存取其所屬 workspace 範圍內的資料。
- **REQ-T3** WHEN 管理員邀請成員，THE 系統 SHALL 寄出邀請並在接受後將其納入該 workspace。
- **REQ-T4** IF 使用者嘗試存取非所屬 workspace 的資源，THEN THE 系統 SHALL 拒絕並回 404（不洩漏存在性）。

### 3.2 身分與權限
- **REQ-A1** THE 系統 SHALL 支援 JWT/OIDC 登入與 workspace 內 RBAC（admin/scheduler/member/guest）。
- **REQ-A2** WHEN 角色被變更，THE 系統 SHALL 於下一次請求即時生效。

### 3.3 行事曆與事件
- **REQ-C1** WHEN 成員建立事件，THE 系統 SHALL 記錄標題、UTC 起訖、時區、參與者、地點/資源與可見性。
- **REQ-C2** THE 系統 SHALL 支援重複性事件（RFC 5545 RRULE）與單次例外。
- **REQ-C3** WHEN 事件被建立或更新，THE 系統 SHALL 以每位參與者所在時區正確顯示時間。
- **REQ-C4** THE 系統 SHALL 支援可見性層級（public/busy/private）。

### 3.4 智慧排程
- **REQ-S1** WHEN 為多位參與者安排會議，THE 系統 SHALL 計算共同空檔並建議前 N 個時段。
- **REQ-S2** IF 新事件與既有事件在同一參與者/資源重疊，THEN THE 系統 SHALL 標記衝突並提出替代時段。
- **REQ-S3** WHEN 使用者以自然語言輸入，THE 系統 SHALL 解析為結構化事件草稿供確認。
- **REQ-S4** THE 系統 SHALL 尊重每位使用者的工作時間、緩衝與免打擾時段。

### 3.5 資源預約
- **REQ-R1** THE 系統 SHALL 允許管理員定義可預約資源（會議室/設備）並設定容量與可用時間。
- **REQ-R2** WHEN 資源被同一時段重複預訂，THE 系統 SHALL 阻止並回傳衝突原因。

### 3.6 提醒與通知
- **REQ-N1** WHEN 事件建立/變更/取消，THE 系統 SHALL 通知受影響參與者。
- **REQ-N2** THE 系統 SHALL 支援「會議前 N 分鐘」提醒，且不阻塞 API 路徑。
- **REQ-N3** THE 系統 SHALL 發布事件生命週期 Webhook 供租戶整合。

### 3.7 AI Agent 整合
- **REQ-M1** THE 系統 SHALL 提供本機 MCP Server，讓外部 AI Agent 調用核心排程能力。
- **REQ-M2** THE 系統 SHALL 強制 agent 的每個 tool call 通過與人類相同的授權鏈（PEP→PDP→RLS），不因 AI 調用而豁免。

### 3.8 稽核與合規
- **REQ-X1** THE 系統 SHALL 記錄敏感操作稽核日誌（誰/何時/對何資源，含 agent 來源）。
- **REQ-X2** WHEN workspace 要求匯出或刪除資料，THE 系統 SHALL 於承諾時限內完成（GDPR）。

## 4. 核心 Schema 硬限制（可追溯）

### ISO-*（資料隔離底線）
- **ISO-1** 每張業務 table SHALL 含 `workspace_id uuid NOT NULL`，並建前綴為 `workspace_id` 的複合索引。
- **ISO-2** 所有 SELECT/INSERT/UPDATE/DELETE SHALL 綁定 `workspace_id`（RLS + Repository 強制）。
- **ISO-3** `workspace_id` 值 SHALL 僅來自已驗證 JWT `workspace` claim，絕不來自 body/query/header。
- **ISO-4** 未設 workspace 脈絡的查詢 SHALL 回 0 筆（deny-by-default）。
- **ISO-5** 應用 DB 角色 SHALL NOT 具 BYPASSRLS/superuser。
- **ISO-6** CI SHALL 含跨 workspace 滲透測試（讀/寫 0 筆、WITH CHECK 拒寫）。

### TZ-*（時區）
- **TZ-1** 時間欄位 SHALL 為 `timestamptz`，命名以 `_utc` 結尾。
- **TZ-2** 寫入值 SHALL 為 UTC 瞬時（應用層完成本地→UTC）。
- **TZ-3** 查詢 SHALL NOT 使用 `AT TIME ZONE`/session timezone 做顯示換算；DB 僅做 UTC 比較/排序。
- **TZ-4** 需還原牆上時間的事件 SHALL 另存 `timezone`（IANA）。
- **TZ-5** DB 連線 SHALL 固定 `timezone=UTC`。
- **TZ-6** 重複事件跨 DST 對齊 SHALL 由應用層以 IANA tz 計算。

### REC-*（重複事件，RFC 5545）
- **REC-1** 重複規則 SHALL 以 `RRULE` 存 `events.rrule`；附加/排除以 `rdate`/`exdate`。
- **REC-2** 重複事件 SHALL NOT 在 DB 展開為多列；occurrence SHALL 於查詢時在應用層依窗口展開。
- **REC-3** 單次修改 SHALL 以獨立 event 列表示，`recurrence_id` 指向被覆寫 occurrence 原始時間，`master_id` 指向主事件。
- **REC-4** 單次取消 SHALL 以 master 的 `exdate` 表示。
- **REC-5** 無界重複展開 SHALL 受窗口與硬上限保護。
- **REC-6** occurrence 跨 DST 展開 SHALL 由應用層以 `timezone` 計算。

## 5. 非功能需求

| 類別 | 需求 |
|---|---|
| 可用性 | 月度 99.9% |
| 效能 | 空檔查詢 P95 < 500ms（≤50 參與者、90 天窗口） |
| 擴充性 | ≥10,000 workspace、單 workspace 100k 事件 |
| 安全 | 傳輸/靜態加密；workspace 強隔離；最小權限；零信任 |
| 合規 | GDPR；朝 SOC 2 Type II |
| 可觀測性 | 結構化日誌、指標、追蹤、每 workspace 計量 |
| 在地化 | 多語系、完整時區/DST |

## 6. 驗收標準（高層）
- 兩個 workspace 資料在任何 API/MCP 路徑皆無法互相存取（含直接 ID 猜測）。
- 為 3 位跨時區成員安排會議得到正確共同空檔。
- 自然語言輸入產生正確事件草稿並可一鍵建立。
- 外部 AI Agent 的越權/跨 workspace tool call 一律被拒（forbidden/not-found + DB 0 筆）。
- 會議前 N 分鐘提醒準時送達，改期/取消不發過時提醒。

## 7. 待確認決策
1. PDP 選 OPA（本 spec 預設）或 Casbin。
2. 計費模型（席次/用量/混合）。
3. 資料落地區域與多 region。
4. NLP 首版規則式 vs 直接接 LLM。
