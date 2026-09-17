# 基礎設施：Docker Compose 本機部署

> 狀態：草案 v0.1 · 最後更新 2026-09-14 · 對應 `design.md`

## 服務總覽

| service | 映像/來源 | 對外埠 | 職責 | 依賴 |
|---|---|---|---|---|
| web | apps/web (node:20+Vite) | 5173 | React 前端 | api |
| api | apps/api (node:20+Fastify) | 3000 | REST API/排程/PEP | db,redis,opa |
| worker | 同 api 映像 | — | BullMQ 通知/提醒/同步 | db,redis |
| mcp | 同 api 映像 | 3001 | MCP Server | db,redis,opa |
| db | postgres:16 | 5432(內) | 權威 DB + RLS | — |
| redis | redis:7 | 6379(內) | 快取+BullMQ | — |
| opa | openpolicyagent/opa | 8181(內) | PDP(Rego) | — |
| mailhog | mailhog/mailhog | 8025(UI) | 本機收信 | — |
| migrate | 同 api (run-once) | — | migration+RLS+seed | db |

## docker-compose.yml

```yaml
name: smart-calendar

x-app-env: &app-env
  NODE_ENV: development
  DATABASE_URL: postgres://app_user:${DB_PASSWORD}@db:5432/${DB_NAME}
  REDIS_URL: redis://redis:6379
  OPA_URL: http://opa:8181
  SMTP_HOST: mailhog
  SMTP_PORT: 1025
  JWT_SECRET: ${JWT_SECRET}
  PGTZ: UTC

services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
      TZ: UTC
    volumes: [ "pgdata:/var/lib/postgresql/data" ]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d ${DB_NAME}"]
      interval: 5s
      timeout: 3s
      retries: 10
    expose: ["5432"]

  redis:
    image: redis:7
    command: ["redis-server", "--appendonly", "yes"]
    volumes: [ "redisdata:/data" ]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    expose: ["6379"]

  opa:
    image: openpolicyagent/opa:latest
    command: ["run", "--server", "--addr", "0.0.0.0:8181", "/policies"]
    volumes: [ "./policies:/policies:ro" ]
    expose: ["8181"]

  mailhog:
    image: mailhog/mailhog
    ports: [ "127.0.0.1:8025:8025" ]
    expose: ["1025"]

  migrate:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: ["node", "dist/migrate.js"]
    environment:
      <<: *app-env
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/${DB_NAME}
    depends_on:
      db: { condition: service_healthy }
    restart: "no"

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: ["node", "dist/server.js"]
    environment: *app-env
    ports: [ "127.0.0.1:3000:3000" ]
    volumes:
      - ./apps/api:/app/apps/api
      - ./packages/shared:/app/packages/shared
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 10s
      timeout: 3s
      retries: 5

  worker:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: ["node", "dist/worker.js"]
    environment: *app-env
    depends_on:
      redis: { condition: service_healthy }
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    stop_grace_period: 30s

  mcp:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: ["node", "dist/mcp-server.js"]
    environment:
      <<: *app-env
      MCP_TRANSPORT: http
    ports: [ "127.0.0.1:3001:3001" ]
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
      opa: { condition: service_started }

  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    command: ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
    environment:
      VITE_API_URL: http://localhost:3000
    ports: [ "127.0.0.1:5173:5173" ]
    volumes:
      - ./apps/web:/app/apps/web
      - ./packages/shared:/app/packages/shared
    depends_on: [ api ]

volumes:
  pgdata:
  redisdata:
```

## .env.example
```dotenv
POSTGRES_PASSWORD=change-me-postgres     # superuser（僅 migration 用）
DB_NAME=calendar
DB_PASSWORD=change-me-appuser            # app_user（無 BYPASSRLS, ISO-5）
JWT_SECRET=change-me-32bytes-min         # 本機 HS256；正式 RS256/JWKS
```

## 關鍵設計點
1. **埠只綁 127.0.0.1**：api/web/mcp/mailhog 綁 localhost；db/redis/opa 僅 expose（內網）。
2. **DB 雙角色**（ISO-5）：migrate 用 postgres(owner) 建表+啟 RLS+建 app_user；api/worker/mcp 用 app_user（無 BYPASSRLS）。
3. **啟動順序**：db+redis healthy → migrate(run-once) → api/worker/mcp → web；opa/mailhog 無狀態隨時起。
4. **持久化**：pgdata/redisdata named volume；Redis appendonly 讓 delayed job 重啟後仍在（提醒不遺失）。
5. **UTC 固定**（TZ-5）：db TZ=UTC、連線 PGTZ=UTC。
6. **共用映像**：api/worker/mcp/migrate 皆 build 自 apps/api/Dockerfile，僅換 command。

## 指令
```bash
cp .env.example .env
docker compose up --build
docker compose logs -f api worker mcp
docker compose down        # 保留 volume
docker compose down -v     # ⚠️ 連資料一起刪
```
