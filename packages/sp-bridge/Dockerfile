# sp-bridge — headless SuperSync peer exposing the canonical REST API.
# Build context: repo root (see docker/deployment/compose.yml).

FROM node:24-alpine AS builder
WORKDIR /repo

# Workspace manifests first (layer caching)
COPY package.json package-lock.json ./
COPY packages/sync-core/package.json ./packages/sync-core/
COPY packages/shared-schema/package.json ./packages/shared-schema/
COPY packages/sp-bridge/package.json ./packages/sp-bridge/

# Only the three needed workspaces — skips the Angular root install entirely
RUN npm ci --ignore-scripts --include-workspace-root=false \
    --workspace @sp/sync-core \
    --workspace @sp/shared-schema \
    --workspace @sp/sp-bridge

COPY packages/sync-core ./packages/sync-core
COPY packages/shared-schema ./packages/shared-schema
COPY packages/sp-bridge ./packages/sp-bridge

RUN npm run build --workspace @sp/sync-core \
 && npm run build --workspace @sp/shared-schema \
 && npm run build --workspace @sp/sp-bridge

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Whole workspace tree: node_modules/@sp/* are symlinks into packages/, so
# both must travel together.
COPY --from=builder /repo /app

EXPOSE 1902
CMD ["node", "packages/sp-bridge/dist/index.js", "serve"]
