# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json

FROM manifests AS build
# Install only the two core workspaces and their root build dependencies.
RUN npm ci --workspace=@personal-agent/server --workspace=@personal-agent/contracts --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/server ./apps/server
COPY packages/contracts ./packages/contracts
RUN npm run build && npm run test --workspace=@personal-agent/server

FROM manifests AS production-dependencies
# The core runtime has no required optional dependency; keep the image minimal.
RUN npm ci --omit=dev --omit=optional --workspace=@personal-agent/server --workspace=@personal-agent/contracts --include-workspace-root --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS server
WORKDIR /app
ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8787 \
    AGENT_DATA_DIR=/data \
    AGENT_RUNTIME=disabled
# No compiler, mobile dependencies, host credentials or personal files.
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server ./apps/server
COPY --from=production-dependencies /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY deploy/entrypoint.mjs deploy/read-secret.mjs ./deploy/
RUN mkdir -p /data && chown node:node /data \
    && node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE health (id INTEGER)'); db.close();"
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:8787/health', {signal: AbortSignal.timeout(3000)}); if (!r.ok) process.exit(1);"]
CMD ["node", "deploy/entrypoint.mjs"]


# Optional isolated model runner: no API database or device connection key.
FROM server AS runner
USER root
ARG CODEX_VERSION=0.154.0
RUN npm install --global --ignore-scripts --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && codex --version \
    && mkdir -p /state /workspace \
    && chown node:node /state /workspace \
    && chmod 700 /state /workspace
ENV AGENT_CHATGPT_PROFILE_DIR=/state/profile \
    AGENT_RUNNER_WORKSPACE=/workspace \
    RUNNER_HOST=0.0.0.0 \
    RUNNER_PORT=8788
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:8788/health', {signal: AbortSignal.timeout(3000)}); if (!r.ok) process.exit(1);"]
CMD ["node", "deploy/entrypoint.mjs", "--runner"]
