# The watcher and the read-only MCP server in one image: the watcher starts the server as a child process over
# stdio and passes it only the server's own settings (docs/watcher.md). Deploy: docs/deploy.md.
# Base image pinned by digest; Dependabot updates it (.github/dependabot.yml).
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/watcher/package.json packages/watcher/
RUN npm i -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
 && pnpm install --frozen-lockfile
# Only the two packages the image ships: the write server (packages/mcp-write) never runs in the cluster.
COPY packages/mcp-server packages/mcp-server
COPY packages/watcher packages/watcher
RUN pnpm --filter @ops-agent/mcp-server --filter @ops-agent/watcher build \
 && pnpm --filter @ops-agent/mcp-server deploy --prod /out/mcp-server \
 && pnpm --filter @ops-agent/watcher deploy --prod /out/watcher

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
LABEL org.opencontainers.image.source="https://github.com/cosmin-mavrichi/ops-agent" \
      org.opencontainers.image.description="Read-only ops agent: watcher and MCP server" \
      org.opencontainers.image.licenses="UNLICENSED"
WORKDIR /app
# The watcher finds the server at ../../../mcp-server/dist/src/index.js from its own dist/src.
COPY --from=build /out/mcp-server /app/mcp-server
COPY --from=build /out/watcher /app/watcher
USER node
CMD ["node", "/app/watcher/dist/src/index.js"]
