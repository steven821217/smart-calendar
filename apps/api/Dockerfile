# 共用映像：api / worker / mcp / migrate 皆 build 自此檔，僅換 compose 的 command。
# 以 tsx 直接執行 TypeScript（此專案以 .js 副檔名 import + tsx/vitest 解析，
# 不做 tsc build step 以避免 moduleResolution=Bundler 的輸出風險）。
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# 只複製 manifest 先裝相依（善用 layer cache）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages/shared/package.json packages/shared/package.json

# 只裝 api + shared 這條相依鏈（web 不進此映像）
RUN pnpm install --frozen-lockfile --filter @scal/api... --filter @scal/mcp...

# 複製原始碼
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/mcp apps/mcp

# 預設跑 API server；compose 以 command 覆寫成 worker / mcp / migrate
WORKDIR /app/apps/api
EXPOSE 3000 3001
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
