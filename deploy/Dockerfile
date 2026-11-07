# Self-hosted blift: Node runtime + SQLite (node:sqlite). Build from the repo root:
#   docker build -f deploy/Dockerfile -t blift .
FROM node:24-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@10.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY server server
COPY web web
RUN pnpm --filter web build && pnpm --filter server build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data WEB_DIR=/app/web PORT=8080
# The server bundle is self-contained (no node_modules needed).
COPY --from=build /src/server/dist/server.mjs /app/server.mjs
COPY --from=build /src/web/dist /app/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "/app/server.mjs"]
