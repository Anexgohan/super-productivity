# syntax=docker/dockerfile:1.7-labs
# (labs syntax is needed for COPY --exclude in the app-rules stage)
#
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
    --workspace @sp/sp-bridge \
 && npm cache clean --force

COPY packages/sync-core ./packages/sync-core
COPY packages/shared-schema ./packages/shared-schema
COPY packages/sp-bridge ./packages/sp-bridge

# build:bridge, not build: the app rules need the app's packages and is built in its own stage below.
RUN npm run build --workspace @sp/sync-core \
 && npm run build --workspace @sp/shared-schema \
 && npm run build:bridge --workspace @sp/sp-bridge

# ── App rules for the state check (anex/state-check) ───────────────────────
# The app's own reducers and archive code, built from the app's source with the app's packages into one self-contained
# file. This stage needs the whole root install; the runtime image gets only the built file.
# Plain JavaScript, the same on every platform, so it builds on the build host's own (as the web image's build stage does).
FROM --platform=$BUILDPLATFORM node:24 AS app-rules
WORKDIR /repo

# Every workspace manifest: a root `npm ci` refuses to run with any of them missing.
COPY package.json package-lock.json ./
COPY packages/plugin-api/package.json ./packages/plugin-api/
COPY packages/plugin-dev/package.json ./packages/plugin-dev/
COPY packages/shared-schema/package.json ./packages/shared-schema/
COPY packages/sp-bridge/package.json ./packages/sp-bridge/
COPY packages/super-sync-server/package.json ./packages/super-sync-server/
COPY packages/sync-core/package.json ./packages/sync-core/
COPY packages/sync-providers/package.json ./packages/sync-providers/
COPY packages/vite-plugin/package.json ./packages/vite-plugin/
RUN npm ci --ignore-scripts && npm cache clean --force

# Sources only, listed explicitly: deployment config (docker/, .env) never enters this stage, and local node_modules or
# dist folders never overwrite what `npm ci` installed.
COPY tsconfig.base.json ./
COPY tools/load-env.js ./tools/
COPY src ./src
COPY electron ./electron
COPY --exclude=**/node_modules --exclude=**/dist packages ./packages

# env.generated.ts is gitignored and imported by the app. Always the empty placeholder, even when the build context
# carries a filled one: the app rules read none of its keys, and none may end up in the image.
RUN rm -f src/app/config/env.generated.ts \
 && node tools/load-env.js --ensure \
 && npm run build:app-rules --workspace @sp/sp-bridge

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Whole workspace tree: node_modules/@sp/* are symlinks into packages/, so
# both must travel together.
COPY --from=builder /repo /app
# One self-contained file, loaded only when SP_STATE_CHECK is on.
COPY --from=app-rules /repo/packages/sp-bridge/dist/app-rules-worker.js /app/packages/sp-bridge/dist/app-rules-worker.js

EXPOSE 1902
CMD ["node", "packages/sp-bridge/dist/index.js", "serve"]
