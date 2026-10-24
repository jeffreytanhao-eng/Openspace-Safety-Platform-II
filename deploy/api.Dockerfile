# 后端：Node.js 22 + TypeScript（可读源码，不使用 bytenode / .jsc）
# 构建上下文为仓库根目录（见 docker-compose.yml 的 context: ..）

# ---------- 构建阶段 ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY api/package.json api/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY api/package.json api/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

# 上传目录（可选，接口后续使用）
RUN mkdir -p /app/uploads
VOLUME ["/app/uploads"]

EXPOSE 1234
CMD ["node", "dist/server.js"]
