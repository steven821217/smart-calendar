# 設計文件：多租戶智慧日曆 SaaS 系統

> 狀態：草案 v0.1 · 最後更新 2026-09-14 · 對應 `requirements.md`

## 1. 技術棧（定案）

| 層 | 選型 |
|---|---|
| 前端 | React + Vite + TypeScript + Tailwind CSS + shadcn/ui + lucide-react；**自刻 CSS Grid 日曆 + date-fns/date-fns-tz**；@dnd-kit/core（拖曳）；framer-motion + sonner；TanStack Query；React Hook Form + zod（詳見 `frontend.md`） |
| 後端 | Node.js 20 + TypeScript + **Fastify**（可換 Express，PEP 與框架解耦） |
| Agent 協定 | MCP（`@modelcontextprotocol/sdk`），tool 複用同一授權鏈 |
| 認證授權 | JWT → PEP → OPA/Casbin (PDP) → RLS 兜底 |
| 資料庫 | PostgreSQL 16 + Row-Level Security（`workspace_id` 隔離） |
| 快取/佇列 | Redis 7 + BullMQ（延遲任務、DLQ） |
| 共享型別 | `packages/shared`（zod schema，前後端 + MCP 共用） |
| 基礎設施 | Docker Compose（web/api/worker/mcp/db/redis/opa/mailhog/migrate） |
| 智慧排程 | 規則式：衝突偵測 + free/busy 空檔建議 + NLP 草稿 |

## 2. 架構總覽（模組化單體）

```
   Web(React) ──▶ API(Fastify) ──▶ PostgreSQL(RLS, workspace_id)
                     │  ▲              ▲
   AI Agent ─MCP─▶ MCP Server         │
                     │                │
                     ▼                │
                 Redis(快取/佇列) ◀── Worker(BullMQ: 通知/提醒/同步)
                     │
                 MailHog(本機收信)
```

**模組**：Tenancy(workspace/成員/角色) · Calendar(事件/行事曆/重複/資源) · Scheduling(空檔/衝突/建議/NLP) · Integration(外部同步/Webhook/通知) · Platform(稽核/計量)。

**專案結構（monorepo）**
```
/
├─ docker-compose.yml   ├─ .env.example
├─ apps/ api/ web/ worker/ mcp/
├─ packages/ shared/
├─ policies/            # OPA Rego（若選 OPA）
└─ .kiro/specs/multi-tenant-smart-calendar/
```

## 3. 資料模型

原則：時間存 UTC（TZ-*）；每業務表帶 `workspace_id`（ISO-*）；重複事件不展開（REC-*）；敏感表軟刪 `deleted_at`。

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";   -- 資源防雙訂 EXCLUDE 用

-- 全域身分（不套 workspace RLS）
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL, display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug citext UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  region text, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','scheduler','member','guest')),
  timezone text NOT NULL DEFAULT 'UTC',
  working_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id));

CREATE TABLE calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES memberships(id),
  name text NOT NULL,
  visibility text NOT NULL DEFAULT 'busy' CHECK (visibility IN ('public','busy','private')),
  created_at timestamptz NOT NULL DEFAULT now());

-- 事件：三態（single/master/exception），時間存 UTC
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title text NOT NULL, description text,
  start_utc timestamptz NOT NULL, end_utc timestamptz NOT NULL,
  timezone text NOT NULL,                          -- IANA 原始時區
  rrule text, rdate timestamptz[], exdate timestamptz[],
  recurrence_id timestamptz,                        -- exception 指向被覆寫 occurrence
  master_id uuid REFERENCES events(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'busy' CHECK (visibility IN ('public','busy','private')),
  location text, created_by uuid NOT NULL REFERENCES memberships(id),
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app','agent','google','m365')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  CHECK (end_utc > start_utc),
  CHECK (
    (rrule IS NULL AND recurrence_id IS NULL AND master_id IS NULL)
    OR (rrule IS NOT NULL AND recurrence_id IS NULL AND master_id IS NULL)
    OR (rrule IS NULL AND recurrence_id IS NOT NULL AND master_id IS NOT NULL)),
  UNIQUE (workspace_id, master_id, recurrence_id));

CREATE TABLE event_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id uuid REFERENCES memberships(id), guest_email citext,
  response_status text NOT NULL DEFAULT 'needs_action'
    CHECK (response_status IN ('needs_action','accepted','declined','tentative')),
  is_organizer boolean NOT NULL DEFAULT false,
  UNIQUE (event_id, member_id),
  CHECK (member_id IS NOT NULL OR guest_email IS NOT NULL));

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, type text NOT NULL DEFAULT 'room' CHECK (type IN ('room','equipment')),
  capacity int, availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE resource_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  start_utc timestamptz NOT NULL, end_utc timestamptz NOT NULL,
  CHECK (end_utc > start_utc),
  EXCLUDE USING gist (resource_id WITH =, tstzrange(start_utc, end_utc) WITH &&));  -- 防雙訂

CREATE TABLE event_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id uuid REFERENCES memberships(id),
  lead_minutes int NOT NULL CHECK (lead_minutes >= 0),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','push','webhook')),
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, member_id, lead_minutes, channel));

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL, secret text NOT NULL, events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','agent','system')),
  on_behalf_of uuid, agent_id text,
  action text NOT NULL, target_type text, target_id uuid,
  decision text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now());

-- 索引（前綴 workspace_id）
CREATE INDEX ON events (workspace_id, calendar_id, start_utc, end_utc) WHERE deleted_at IS NULL;
CREATE INDEX ON events (workspace_id, master_id);
CREATE INDEX ON event_participants (workspace_id, member_id);
CREATE INDEX ON resource_bookings (workspace_id, resource_id, start_utc);
CREATE INDEX ON event_reminders (workspace_id, event_id);
CREATE INDEX ON audit_log (workspace_id, at DESC);
```

RLS policy 對每張帶 `workspace_id` 的表套用（見 `security.md`）。

## 4. 智慧排程引擎（確定性，非 ML）

1. **free/busy**：合併每位參與者忙碌區間（含重複展開、工作時間、緩衝、免打擾），取補集為候選空檔；掃描線演算法達 P95<500ms（REQ-S1）。
2. **時段評分**：啟發式（就近、避免破碎、尊重核心工時、時區公平）取前 N。
3. **衝突偵測**：建立/更新對參與者與資源做重疊檢查，回替代時段（REQ-S2）。
4. **NLP**：規則式 `Parser` 介面產生草稿，日後可換 LLM 不動上層（REQ-S3）。
- 快取：free/busy 結果存 Redis，事件變更以 workspace+member 失效。

## 5. 非同步延遲任務架構（Redis + BullMQ）

> 完整條文見 `requirements.md`（ASYNC-*）。核心：**事件驅動，非 DB 輪詢**。

- **反模式（不採用）**：`setInterval` 每分鐘掃 DB 找到期提醒——DB 熱點、精度受輪詢間隔限制、需自建鎖/重試/去重。
- **採用**：建立事件時把提醒排成 **BullMQ delayed job**（`delay = runAt − now`），進 Redis delayed set（score=runAt）。Redis 依到期喚醒，把 job 移到 active，`worker` 消費——DB 不參與「是否到期」判定，僅在發送時讀當前事件現況。
- **精度**：秒級，不受輪詢間隔限制。
- **擴充**：多 worker 競爭消費，Redis 保證單 job 單次處理，無需分散式鎖。
- **無界重複**：repeatable job 滾動補排近期窗口（非全量輪詢）。

```
建立事件 ─add(delay)─▶ Redis delayed set(score=runAt) ─到期─▶ active ─▶ worker 發提醒
   （Node.js 全程不輪詢 events/reminders 表）
```

## 6. 整合與非同步
- **外部同步**：Google/M365 OAuth 增量同步（sync token/delta），source 標記去重。
- **Webhook**：HMAC 簽章外送，重試 + DLQ。
- **通知/提醒**：BullMQ 佇列，Worker 送出（本機 → MailHog）。

## 7. 可觀測性與部署
- 容器化 K8s（未來）；本機 Docker Compose。單 region 起步，資料模型預留 region。
- 結構化日誌 + 指標 + 追蹤，帶 `workspace_id` 維度（日誌不含私密事件內容）。
- CI/CD：每次變更跑含「跨 workspace 隔離滲透測試」的套件。

## 8. 主要技術風險
| 風險 | 緩解 |
|---|---|
| 連線池未正確設 workspace 脈絡致外洩 | 中介層 `SET LOCAL` 強制 + RLS 兜底 + 自動化滲透測試 |
| 重複事件展開熱點 | 窗口化按需展開 + 快取 + 上限 |
| 外部同步迴圈/重複 | source 標記 + sync token 去重 |
| RLS 於複雜報表效能 | 唯讀副本 / 物化視圖 |
