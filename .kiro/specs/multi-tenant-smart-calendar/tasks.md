# 實作任務清單：多租戶智慧日曆 SaaS 系統

> 狀態：草案 v0.3 · 最後更新 2026-09-15（以程式碼實況核對）
> 對應 `requirements.md` / `design.md` / `security.md` / `api.md` / `mcp.md` / `infrastructure.md`
> 每項標註對應需求/條文。建議依序執行；隔離骨架（階段 3）是地基，先讓其滲透測試由紅轉綠。
> v0.2：完成 5.4 規則式 NLP、9.5 NLQuickAdd、10.1 Email→MailHog、10.2 Webhook+HMAC+DLQ；測試 69→89。
> v0.3：以原始碼核對後同步狀態 — 0.3 Dockerfile（api/web/gateway 皆存在）、8.3 OAuth 2.1 consent、
>   8.8 Streamable HTTP + gateway 皆**已完成**（原標「延後」為過時）；測試實測 **134**（api/test 22 檔）。
>   仍未做：3.2 refresh token、7.4 repeatable 補排、9.8 Inter 自託管、10.3 外部日曆同步、
>   10.4 每-workspace 指標/追蹤、10.5 Bull Board、11.2 驗收腳本。
> v0.4：完成 7.4 repeatable 補排、9.8 Inter 自託管、10.4 每-workspace 指標/追蹤、11.2 驗收腳本
>   （各項 tsc 通過 + 新測試綠燈；prom-client@15.1.3 / @fontsource-variable/inter@5.3.0 需 pnpm install）。
>   仍未做：3.2 refresh token、10.3 外部日曆同步、10.5 Bull Board（選）。

## 階段 0 — 專案鷹架  ✅
- [x] 0.1 建 monorepo：`apps/{api,web,worker,mcp}` + `packages/shared`（pnpm workspaces）
- [x] 0.2 TypeScript 設定、共用 tsconfig（lint 規則延後）
- [x] 0.3 `apps/api/Dockerfile`（api/worker/mcp/migrate 共用）、`apps/web/Dockerfile`、`gateway/Dockerfile`  ✅（容器化已落地）
- [x] 0.4 `docker-compose.yml` + `.env.example`（db/redis/opa）
- [x] 0.5 `packages/shared`：zod schema 骨架（EventInput/Occurrence/Problem）

## 階段 1 — DB 地基（Req 1）  ✅
- [x] 1.1 `migrate.ts`：啟用 `pgcrypto`、`btree_gist`、`citext`
- [x] 1.2 建 11 表（依 `design.md`）
- [x] 1.3 events 三態 CHECK + `EXCLUDE USING gist` 資源防雙訂（REQ-R2）
- [x] 1.4 索引（前綴 workspace_id）
- [x] 1.5 建 `app_user`（NOSUPERUSER NOBYPASSRLS，ISO-5）
- [x] 1.6 seed 兩個示範 workspace（ws-a/ws-b）

## 階段 2 — 隔離骨架（ISO-*，地基）  ✅
- [x] 2.1 10 表 `ENABLE/FORCE RLS` + `workspace_isolation` policy（NULLIF 穩健版）
- [x] 2.2 `withWorkspace()`：每交易 `SET LOCAL app.current_workspace`
- [x] 2.3 Service/Repository 層收斂（events/resources 皆走 withWorkspace）
- [x] 2.4 **跨 workspace 滲透測試通過**（讀 0 筆、WITH CHECK 拒寫、未設脈絡 0 筆、非 superuser）

## 階段 3 — AuthN + PEP/PDP（Req: A1/A2, PEP-*）  ✅（3.2 refresh 延後）
- [x] 3.1 JWT 驗證（HS256, timingSafeEqual）+ AuthContext → onRequest hook
- [ ] 3.2 refresh token + Redis 撤銷黑名單  ← 延後（核對：apps/ 無 refresh token 實作；agent M2M token 撤銷黑名單另在 oauth 已有）
- [x] 3.3 `authorize(input)` 抽象（框架解耦，PEP-4）
- [x] 3.4 OPA 接線（`opa` 容器）+ `policies/authz.rego`（RBAC + ABAC）
- [x] 3.5 PEP：SQL 之前求值，deny→403(同 ws)/404(跨 ws)；PDP 不可用 fail-closed
- [x] 3.6 授權決策測試（9 條）

## 階段 4 — 事件 CRUD + 重複展開（Req 2, EV-*, REC-*）  ✅（4.4 PUT occurrences 以 scope=this 涵蓋）
- [x] 4.1 POST/GET/PATCH/DELETE `/v1/events`
- [x] 4.2 occurrence 展開（rrule）：窗口內、rdate/exdate、exception 覆寫
- [x] 4.3 scope=this/this_and_future/all 修改語意（EV-3）
- [x] 4.4 單次例外（scope=this 建 exception；PUT 專屬端點延後）
- [x] 4.5 UTC-only 驗證 + 展開測試
- [x] 4.6 events 端點隔離 + 授權測試

## 階段 5 — 智慧排程（Req: S1/S2/S4）  ✅
- [x] 5.1 free/busy 計算（掃描線合併 + 補集空檔）
- [x] 5.3 衝突偵測 + suggested_slots 邏輯
- [x] 5.2 `GET /v1/availability` 端點 + Redis 快取（30s）  ✅
- [x] 5.4 規則式 NLP `Parser`  ← `packages/shared` `RuleBasedParser`（Parser 介面可換 LLM）；`POST /v1/events/parse`（route 19，event.create PEP）+ MCP tool `parse_event_from_text`；相對日/星期/中英時間/時長/RRULE + IANA 時區換算（DST），產草稿供一鍵確認  ✅

## 階段 6 — 資源預約（Req: R1/R2）  ✅
- [x] 6.1 bookResource（DB EXCLUDE 防雙訂，衝突 → BookingConflictError/409）
- [x] 6.2 資源 HTTP 端點（api.md 22-25）：GET/POST `/v1/resources`、POST/DELETE `/v1/resources/{id}/bookings`（PEP `resource.read`/`resource.create`/`resource.book` → RLS；雙訂 409、跨 ws 404、稽核寫入）  ✅

## 階段 7 — Async 提醒（Req 4, REM-*, ASYNC-*）  ✅
- [x] 7.1 BullMQ reminders 佇列（ioredis 實例）
- [x] 7.2 排/重排/移除 delayed job（穩定 jobId 含 lead 維度）
- [x] 7.3 worker consumer：`SET LOCAL workspace` + 發送前查證防過時提醒
- [x] 7.4 重複事件近期窗口 repeatable 補排  ✅ ← `reminders/recurring.ts`：`rescheduleRecurringWindow`（窗口內每 occurrence×每 reminder 排 job，穩定 jobId 去重、過期跳過）、`backfillUpcomingReminders`（跨 ws 掃 rrule master）；滾動推進用 BullMQ v6 `upsertJobScheduler`（不輪詢 DB，符 7.7）；`createReminder` 對重複事件 commit 後補排；`REMINDER_HORIZON_DAYS=30`；`test/reminders-recurring.test.ts` 7/7 綠
- [x] 7.5 重試+指數退避（attempts:5, backoff）；removeOnFail 保留供 DLQ
- [x] 7.6 event_reminders API + 三層預設  ← GET/POST/DELETE `/v1/events/{id}/reminders`（api.md 26-28）；設提醒寫 event_reminders 並為單次事件排 delayed job、移除時取消 job（PEP event.read/event.update → RLS，跨 ws 404）  ✅
- [x] 7.7 **不輪詢 DB**：delayed job 事件驅動（無 setInterval 掃表）

## 階段 8 — MCP Server（Req 3, MCP-*, ZT-*)  ✅
- [x] 8.1 MCP tool handlers（find/create/book/list occurrences/parse）  ← 含 `parse_event_from_text`（tool 6）
- [x] 8.2 每 tool = PEP：scope 檢查 → authorize → Service（禁旁路，ZT-3）
- [x] 8.3 OAuth 2.1 代理 token 完整流程 + 撤銷  ✅ ← `auth/oauth.ts`（consent + PKCE S256 + 一次性短效 code）
      + `auth/oauth-routes.ts`（`/v1/oauth/consent`、`/v1/oauth/token`）+ 撤銷 Redis 黑名單；`test/oauth-consent.test.ts` 閉環
- [x] 8.4 自動排程閉環（find→create→resolve→retry）+ idempotency_key
- [x] 8.5 book_resource require_confirmation（MCP-12）；find_availability 僅 free/busy（MCP-11）  ✅
- [x] 8.6 agent 稽核（actor_type=agent, on_behalf_of, source=agent, MCP-13）  ✅
- [x] 8.7 **零信任滲透測試**（ZT-7）：agent 越權 + 跨 workspace + 撤銷後 fail-closed  ✅
- [x] 8.8 Streamable HTTP + gateway（TLS/rate-limit），mcp 不直接對公網（MCP-10）  ✅
      ← `mcp/http.ts`（`StreamableHTTPServerTransport`，listen 3001，內網）+ `gateway/`（nginx 反代 /mcp、自簽 TLS、per-IP rate-limit）；`test/mcp-http-e2e.test.ts`

## 階段 9 — 前端（Req 5, UI-*；詳見 frontend.md）
> 主幹 9.1–9.4 已完成（Vite+React+TS+Tailwind、自刻月/週視圖、事件 CRUD）。
> 進階項（dnd 拖曳、編輯器細項、空檔卡片、Agent 管理 UI）待續。
> 後端另補：`POST /v1/auth/login`(dev)、`GET /v1/auth/me`、`GET /v1/calendars`、CORS。
- [x] 9.1 Vite + React + TS + Tailwind 骨架 + 登入 + light/dark/system 主題  ✅
- [x] 9.2 **自刻 CSS Grid 月/週視圖 + date-fns/date-fns-tz**（依觀看者 IANA，UI-17/18）  ✅
- [x] 9.3 **@dnd-kit/core 拖曳改期**（DragOverlay + snap；PointerSensor+KeyboardSensor；樂觀更新 + 409 回滾 + suggested_slots，UI-20/21/22）  ✅
- [x] 9.4 建立/編輯事件（含 ScopeChooser：this/this_and_future/all，UI-5）  ✅（RecurrenceEditor/ParticipantPicker/ReminderEditor 待細做）
- [x] 9.5 空檔建議卡片（GET /availability）✅；NLQuickAdd（/events/parse）✅  ← `NLQuickAdd` topbar 元件呼叫 `POST /v1/events/parse`，草稿一鍵開啟建立表單（觀看者時區回填）；低信心/warnings toast 提示
- [x] 9.6 時區顯示（觀看者 IANA；事件原始時區 ≠ 觀看者時區時於詳情顯示雙時區 GMT±；topbar 標示觀看者時區）  ✅（UI-2）
- [x] 9.7 狀態回饋：framer-motion 進場動畫 + Skeleton + sonner Toast（統一 useMutationWithFeedback；409 附建議時段 action；尊重 reduced-motion）  ✅（UI-23/24/25）
- [x] 9.8 設計系統：cva + tailwind-merge、Inter 自託管、Vercel/Linear 極簡 tokens  ✅ ← tokens/cn 已做；Inter 自託管：`@fontsource-variable/inter@5.3.0`（main.tsx import、globals.css/tailwind 對齊 "Inter Variable" + fallback chain），build 產物 `dist/assets/` 含 7 個 woff2 子集，不打 Google Fonts CDN
- [x] 9.9 **Agent & MCP 管理介面**（Admin）：授權清單（scope/最後活動/狀態）+ 一鍵撤銷（二次確認，即時 fail-closed）+ 稽核活動 Drawer（allow/deny 標色）  ✅（UI-26/27）
- [x] 9.10 TanStack Query + Zustand（RHF+zod 待接）  ✅（Query/Zustand 已用，表單暫用受控元件）

## 階段 10 — 整合/通知/可觀測
- [x] 10.1 通知 Email → MailHog  ← `integrations/mailer.ts` 極簡 SMTP（無新相依）；reminders worker 發送前查證事件現況後寄信；SMTP 未設定則跳過不失敗  ✅
- [x] 10.2 Webhook 訂閱 + HMAC 簽章 + 重試/DLQ（REQ-N3）  ← `GET/POST/DELETE /v1/webhooks`（route 29，webhook.manage=admin，跨 ws 404）；`publishEvent` 於 event.created/updated/deleted 排 BullMQ delivery job（attempts:5 指數退避、removeOnFail:false 供 DLQ）；HMAC-SHA256 簽 `t.body` + 時窗防重放  ✅
- [ ] 10.3 Google/M365 OAuth 增量同步骨架（sync token, source 去重，REQ-N2）  ← 延後（核對：僅 migrate.ts events.source CHECK 含 'google'/'m365' 枚舉；無同步邏輯/OAuth/sync token）
- [x] 10.4 結構化日誌+指標+追蹤（帶 workspace_id；日誌不含私密內容）  ✅ ← `observability/metrics.ts`：prom-client `/metrics`（auth 放行、預設 loopback/內網）+ `scal_http_requests_total`/`scal_http_request_duration_seconds`（label：method/route 樣板/status/workspace，避高基數）/`scal_reminders_sent_total`；每請求日誌帶 `req_id`+`workspace_id`（無 body/私密）；`test/observability.test.ts` 4/4；需 `pnpm add prom-client@15.1.3 -F @scal/api`。延伸：完整 OTel exporter/exemplar、worker 跨-process reminders 計數待接
- [ ] 10.5 (選) Bull Board `/admin/queues`  ← 延後（需新相依）

## 階段 11 — CI/CD 與驗收
- [x] 11.1 CI（GitHub Actions）：api job（db/redis service + OPA container → migrate → seed → tsc → **134 tests 含 ISO-6 滲透 + ZT-7 零信任 + 資源/提醒/Webhook 端點 + NLP parser + 委員會單元/整合/延伸 + MCP stdio/HTTP e2e + OAuth consent 閉環**）＋ web job（tsc + build）  ✅
- [x] 11.2 驗收（依 requirements §6）：兩 ws 互不可見、3 人跨時區空檔、NLP 草稿、agent 越權被拒、提醒準時且不發過時  ✅ ← `apps/api/src/scripts/acceptance.ts`（`pnpm --filter @scal/api acceptance`）：對真實 HTTP 逐條驗 §6 五項，印 `[PASS]/[FAIL]/[SKIP]`，有 FAIL exit 1，缺 MailHog/MCP/Redis graceful skip；tsc 通過。需系統 up（docker compose up）後實跑

## 待決議（開工前確認）
- [ ] PDP：OPA（本 spec 預設）vs Casbin
- [ ] 計費模型
- [ ] 資料落地/多 region
- [ ] NLP：規則式 vs LLM
