# 多租戶智慧日曆 SaaS

規格見 `.kiro/specs/multi-tenant-smart-calendar/`（requirements/design/security/api/mcp/frontend/infrastructure/tasks）。

## 已實作（階段 0-8，後端）
- **隔離底線**：每張業務表 `workspace_id` + Postgres RLS（FORCE，`app_user` 無 BYPASSRLS）；`withWorkspace()` 每交易 `SET LOCAL app.current_workspace`。
- **認證授權**：JWT(HS256) → PEP → OPA(PDP, Rego) → RLS。跨 workspace→404、越權→403、PDP 不可用 fail-closed。
- **事件**：CRUD + RFC 5545 重複展開（rrule/rdate/exdate/exception）+ scope（this/this_and_future/all）。
- **智慧排程**：free/busy 掃描線、空檔評分、衝突偵測。
- **資源**：DB `EXCLUDE USING gist` 防雙訂。
- **提醒**：BullMQ delayed job（會前 N 分、穩定 jobId、改期/取消重排），worker consumer 設 workspace 脈絡 + 發送前查證。
- **MCP**：tool handlers 複用同一授權鏈（scope ∩ role），零信任（無 token/缺 scope/越權皆拒），事件 `source=agent`。
- **內部多智能體委員會（LangGraph.js）**：高階 MCP tool `delegate_complex_scheduling` → `StateGraph`（Coordinator→Negotiator→ResourceManager）把模糊 NL 收斂成一次可執行預約。時間重用 `parseEventFromText`、attendees/resources 由可注入 `ChatModel`（測試走 stub，不打真實 API）解析；公務車前後各 15 分 buffer（半開區間，寫入含 buffer 讓 `EXCLUDE gist` 兜底）；`commitSchedulingPlan` 單交易原子落實（event＋participants＋booking＋提醒），任一步失敗整筆 rollback。功能 A（公務車會前 30 分自動提醒）、B（`explain=true` dry-run 只回 trace 不寫 DB）、D（`committee.decision` 決策稽核）；延伸 C（`option_token` 一鍵確認免重跑圖）、E（`scheduling.needs_decision` webhook）。
- **團隊群組與非同步委派審批（feature-team-groups）**：`groups` / `group_members`（`leader`/`member`）+ `event_participants.rsvp_status`（pending/accepted/declined）；OPA `group.read`/`group.manage`。Coordinator 能把「我的團隊/組員」代名詞解析為真實 member；Leader 幫團隊排會時委員會將成員設 `rsvp_status='pending'`，各自簽發 `rsvp_token` 並觸發 `scheduling.rsvp_pending` webhook；Member 憑 token 呼叫 `POST /v1/events/:id/rsvp`（免登入、token 綁 workspace/event/member）accept 才正式排入。前端：`GroupsPage`（群組/成員管理）、`RsvpPage`（`#/rsvp?event=&token=` 一鍵回覆）。
- **即時推播（SSE）**：進程內 `liveBus`；`publishEvent` 在排 webhook 佇列的同時 emit 到 bus，`GET /v1/events/stream?access_token=<jwt>`（EventSource 無法帶 header 故走 query token、路由自驗、依 workspace 過濾守 ISO-3、心跳 keep-alive）把生命週期事件即時推給瀏覽器，取代輪詢延遲。gateway 對此路徑 `proxy_buffering off`。⚠️ 多實例水平擴展需改 Redis pub/sub。
- **站內對話 agent（B 方案，能查詢也能排會）**：`POST /v1/agent/chat`（登入 user 認證）。意圖 5 類（list/count/find_free/pending/schedule）；查詢分支查真實 DB 回模板答案、排會分支轉委員會（同 ollama 路徑）。**針對本地 14B（qwen3:14b）的 harness**：規則為主、model 兜底；時間一律後端規則算（今天/明天/這週/單一星期X/接下來N天，`Intl` 算時區，model 不碰日期）；14B 只抽模糊語意（filter/group/order），輸出經五層清洗——null 正規化（`"null"→null`）、daypart 原文覆核（沒說「下午」不套）、單日 anchor 優先（清 weekday 雜訊）、規則時間錨點覆核（明確星期規則直算，比 14B 準）、group 覆核（用真實 group 清單還原中文誤拆如「產品團隊」）。簡單問句走規則（0 秒不打 model），複雜問句才叫 14B。答案帶「我怎麼理解的」時間窗標籤，透明化不確定性。授權以 user 真實 role 經 PDP、查詢走 RLS（ISO-3）。前端 `AgentChatDrawer` 側邊對話抽屜（頂欄 🤖 觸發、建議問題）。

## 啟動

### A. 全容器化（一鍵起所有服務，推薦）
```bash
cp .env.example .env
docker compose up --build           # db/redis/opa/migrate/api/worker/mcp/web/mailhog/gateway
```
- 對外**只開 gateway**（`127.0.0.1:9080`→轉址、`127.0.0.1:9443` HTTPS 主入口）；
  api/mcp/web/db/redis/opa 皆在 compose 內網，不直接對公網（MCP-10）。
- gateway 首次啟動自簽 TLS 憑證；反代路由：`/mcp`→mcp、`/v1`·`/health`→api、`/`→web，
  並對 `/mcp`·`/v1` 做 per-IP rate-limit。
- `migrate` 為 run-once（建表+RLS+app_user+seed 示範 ws-a/ws-b）後自動退出。
- 委員會 LLM（三選一）：
  - **雲端 OpenAI**：`.env` 設 `OPENAI_API_KEY`（真實金鑰）、`LLM_BASE_URL` 留空。
  - **本機 model（ollama/LM Studio，OpenAI 相容）**：`.env` 設
    `LLM_BASE_URL=http://host.docker.internal:11434/v1`（全容器化；container 靠此連 host 上的 ollama，
    compose 已為 api/mcp 加 `extra_hosts: host.docker.internal:host-gateway`）、
    `OPENAI_API_KEY=local`（非空佔位值，否則 fail-closed 不呼叫）、
    `LLM_MODEL=qwen3:14b`（需支援 function-calling / JSON structured output）。
    先確保 host 的 ollama 有跑（`ollama serve` 或容器 `docker start ollama`）。
    - **多人並發（PoC 多位使用者同時用外部/站內 agent）**：ollama 預設序列處理，同時多個請求會排隊。
      站內對話 agent 的簡單查詢（今天/明天有什麼、幾個會、有沒有空）走**規則、0 秒、不打 model**，
      故一般查詢不塞；只有複雜查詢與排會才叫 14B（每次約 10-16 秒）。若預期多人同時觸發 14B，
      啟動 ollama 前設 `OLLAMA_NUM_PARALLEL=3`（或更高）與足夠 VRAM 讓多請求並行，避免排隊等待。
  - **純流程驗證（不打 model）**：`MCP_STUB_MODEL=1 docker compose up`，委員會走 stub 抽取。
- 收信 UI：MailHog `http://127.0.0.1:8025`。
```bash
docker compose logs -f api worker mcp gateway
docker compose down        # 保留 volume（pgdata/redisdata/gatewaycerts）
docker compose down -v     # ⚠️ 連資料一起刪
```

### B. 本機開發（不進容器跑 api/web，需要 host 可連 DB）
```bash
cp .env.example .env
pnpm install
# 把 db/redis/opa（及 api/mcp）的埠開回 host，供 host 上的 process 連線
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db redis opa
set -a; . ./.env; set +a
export DATABASE_URL="postgres://app_user:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
export ADMIN_DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@localhost:5432/${DB_NAME}"
export OPA_URL=http://localhost:8181 REDIS_HOST=localhost REDIS_PORT=6379
pnpm --filter @scal/api migrate      # 建表 + RLS + app_user
pnpm --filter @scal/api seed         # 示範 ws-a / ws-b
pnpm --filter @scal/api dev          # Fastify on 127.0.0.1:3000
```
> ⚠️ **本機 model 端點在兩種模式相反**：host 模式（此節，process 在 host）委員會要連 host 的 ollama，
> `.env` 需 `LLM_BASE_URL=http://localhost:11434/v1`；全容器化（A 節）則為
> `http://host.docker.internal:11434/v1`。切換模式時記得改這行。

## 測試
```bash
# 需 db/redis/opa 埠可從 host 連（用上面 B 的 docker-compose.dev.yml 疊加）
pnpm --filter @scal/api test         # 192 tests：isolation/authz/recurrence/events/
                                     #   event-scope/scheduling/reminders/mcp-zerotrust/
                                     #   mcp-hardening/availability-agents/
                                     #   committee-unit/committee-integration/committee-extensions/
                                     #   mcp-server-e2e/mcp-http-e2e/oauth-consent/sse-live/
                                     #   inapp-agent-unit/inapp-agent-integration
```

## 前端（階段 9 主幹，`apps/web`）
```bash
pnpm --filter @scal/api dev          # 先起 API（127.0.0.1:3000）
pnpm --filter @scal/web dev          # Vite on 127.0.0.1:5173
# 登入示範帳號：a@example.com（ws-a）/ b@example.com（ws-b）
```
- React + Vite + TS + Tailwind（HSL token，light/dark/system）。
- 自刻 CSS Grid 月/週視圖，時間依觀看者 IANA（date-fns-tz）換算顯示。
- 事件建立/編輯（含 scope：this/this_and_future/all）；TanStack Query + Zustand。
- **日曆導航**：‹›（月/週）＋«»（年）＋可點標題的 JumpPicker（年份輸入＋12 月份格子）快速跳任意月/年；
  「今天」在已於當前月/週時 disabled。月視圖點日「先選取再建立」（防誤觸），選取日出現 ＋ 明確建立鈕。
- **Agent 事件可見（agent-first UX）**：外部 agent 經 MCP 排的事件在月/週視圖顯示 ✨ 紫色標記，
  編輯對話框顯示「由 AI 助理透過排程委員會建立」來源橫幅（occurrence 帶 `source=agent`）。
- **即時反映（SSE 推播）**：後端 `publishEvent` 經進程內 bus 即時推 `GET /v1/events/stream`（EventSource 走 query token、依 workspace 過濾守 ISO-3），前端收到即 invalidate → 收件匣/最近事件/月曆秒級浮現 agent 的變更；輪詢（60s/120s）退為斷線備援。頂欄有綠色「即時」連線燈。
- **待處理收件匣**：頂欄鈴鐺 `GET /v1/me/pending-rsvps`（SSE 即時 + 輪詢備援），列出 AI 幫你排、待回覆的邀請（未讀數 badge）；per-member 快取，同 workspace 切帳號也正確刷新。
- **RSVP 頁**：Member 一鍵 accept/decline 後顯示事件時間/地點（依事件時區）。
- **最近事件面板**：側欄列出前後 7 天事件（依觀看者時區、agent 事件標 ✨、per-member 快取），不必翻月曆即知近期有什麼事。
- **登出／切換帳號**：左下角帳號區可登出回登入頁，改用其他帳號（如 member）登入（workspace 仍不可於 UI 切換，ISO-3）。
- **團隊群組**：建立/成員管理，刪除有二次確認；提示「設好團隊後可請 AI 助理幫團隊排會」。
- Agent 管理頁：外部 agent 授權/MCP 活動檢視、即時撤銷（admin）。
- **日曆助理對話抽屜（🤖）**：頂欄開啟側邊對話，可問行程（今天/明天/這週有什麼、幾個會、有沒有空、待回覆）也可請它排會；查詢走站內 agent（規則+14B harness），排會轉委員會。附建議問題、答案帶「我怎麼理解的」時間窗標籤。

## MCP 對外接入（階段 8：stdio / Streamable HTTP + OAuth 2.1 consent）

MCP tool handler 之外，現已實作**兩條傳輸**與**正式授權流程**，外部/本機 AI agent 可真的連上並操作日曆。

### 傳輸
- **stdio**（本機/桌面 agent）：`pnpm --filter @scal/mcp start`
- **Streamable HTTP**（對外，**經 gateway**）：容器化後由 gateway 反代 → `https://127.0.0.1:9443/mcp`
  （mcp service 本身 `http://mcp:3001/mcp` 僅在 compose 內網，不直接對公網，MCP-10）。
  純本機不經 gateway 可 `pnpm --filter @scal/mcp start:http` → `http://127.0.0.1:3001/mcp`。

### 暴露的 tools（依 token scope 過濾）
`find_available_time_slots`、`create_smart_event`、`book_resource`、`parse_event_from_text`、
`list_event_occurrences`、`delegate_complex_scheduling`（高階委員會委派）、
`query_calendar`（唯讀查詢個人日曆：明天有哪些會/幾個會/有沒有空/待回覆；on-behalf-of 授權者本人、嚴格個人隔離查不到他人）。

### 授權：OAuth 2.1 consent（Authorization Code + PKCE，mcp.md §3）
```
使用者 login ─→ POST /v1/oauth/consent（勾 scope + PKCE challenge）─→ authorization_code
agent ─→ POST /v1/oauth/token（code + code_verifier）─→ scoped M2M access token
agent ─→ MCP HTTP（Authorization: Bearer <token>）─→ tools（scope∩role 生效）
```
- consent 需**已登入使用者**；寫入類 scope（`event.write`/`resource.book`）需明確勾選（最小授權）。
- authorization_code：一次性、短 TTL（`OAUTH_CODE_TTL_SEC`）；PKCE S256 驗證。
- 發出的是既有 M2M JWT（`sub=agent_id`, `workspace`, `roles`, `scope`）；撤銷走
  `DELETE /v1/agents/{id}/authorization`（即時 Redis 黑名單，MCP-8）。

### 外部 agent 接入步驟
1. **拿 token**（使用者先 login 取 user JWT，agent 端產 PKCE verifier/challenge）：
   ```bash
   # 使用者授權（帶 user token）
   curl -sX POST localhost:3000/v1/oauth/consent \
     -H "authorization: Bearer $USER_JWT" -H 'content-type: application/json' \
     -d '{"agent_id":"my-agent","scope":["availability.read","event.write","resource.book"],
          "code_challenge":"<S256(verifier)>","code_challenge_method":"S256"}'
   # agent 換 token
   curl -sX POST localhost:3000/v1/oauth/token -H 'content-type: application/json' \
     -d '{"grant_type":"authorization_code","code":"<code>","code_verifier":"<verifier>","agent_id":"my-agent"}'
   ```
2. **在 agent 的 MCP 設定登記** server（HTTP：URL `http://<gateway>/mcp` + `Authorization: Bearer <token>`；
   stdio：指令 `pnpm --filter @scal/mcp start` + `MCP_DEV_*` 環境變數）。
3. 連上後 agent 即看到上列 tools，對話中（如「幫我訂 X 會議室，9/20 下午 2 點開會」）會呼叫對應 tool 落實。

> 本機快速驗證（免 gateway、免真 LLM）：`MCP_STUB_MODEL=1` 讓委員會走 stub。
> 端到端測試見 `test/mcp-server-e2e`（stdio）、`test/mcp-http-e2e`（HTTP）、`test/oauth-consent`（consent 閉環）。

## 尚未實作
- 階段 9 進階：空檔卡片/NLQuickAdd（9.5）、跨時區雙時區顯示（9.6）、
  Inter 自託管等設計系統收尾（9.8）、RHF+zod 表單。
- 階段 10 通知 Webhook / 外部日曆同步（Email→MailHog 已於容器化納入）
- 階段 11.2 驗收腳本（requirements §6）
- 後端延後項：refresh token（3.2）、NLP parser（5.4）、event_reminders API（7.6）
- 正式部署：以真憑證取代 gateway 自簽 TLS、RS256/JWKS 取代 HS256

## CI（階段 11.1，`.github/workflows/ci.yml`）
- **api** job：postgres/redis service container + OPA container 載 `policies/` → migrate → seed → tsc → 192 tests（含跨 workspace 滲透 ISO-6、agent 零信任 ZT-7、委員會 stub-model 單元＋整合＋原子性、MCP stdio/HTTP 端到端、OAuth 2.1 consent 閉環、SSE 即時推播授權＋ISO-3 過濾、站內對話 agent harness＋查詢分支 ISO-3）。CI 無 `OPENAI_API_KEY`，委員會/MCP 測試一律注入 stub `ChatModel`，不打真實 LLM。
- **web** job：tsc + production build。
