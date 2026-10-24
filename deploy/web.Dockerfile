# 前端：Vite 6 构建 → nginx 静态托管（监听 1233）
# 构建上下文为仓库根目录（见 docker-compose.yml 的 context: ..）

# ---------- 构建阶段 ----------
FROM node:22-alpine AS build
WORKDIR /app

# Cesium 打包与 vue-tsc 内存占用较高，2GB 轻量服务器构建时给足堆内存
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY web/ ./
# 子路径部署时由 compose 传入 VITE_BASE（默认 /）
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE
RUN npm run build

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine
COPY deploy/nginx/openspace.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 1233
