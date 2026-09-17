# web 映像：build 靜態產物後以 vite preview 服務（容器內綁 0.0.0.0，對外由 gateway 反代）。
# VITE_API_BASE 於 build 時 inline；預設留空 → 前端走相對路徑，與 gateway 同源。
FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @scal/web...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

# 前端走相對路徑（同源打 gateway）；如需絕對位址在 build 時傳 --build-arg VITE_API_BASE=...
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
WORKDIR /app/apps/web
RUN pnpm run build

EXPOSE 4173
# vite preview 綁 0.0.0.0，讓 gateway 容器可反代
CMD ["pnpm", "exec", "vite", "preview", "--host", "0.0.0.0", "--port", "4173"]
