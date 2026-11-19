# syntax=docker/dockerfile:1.7-labs
# (labs syntax is needed for COPY --exclude, used below to keep deployment
#  config out of the Angular build's cache key)

# Build stage
FROM --platform=$BUILDPLATFORM node:22 AS build

# Accept build arguments for environment variables with defaults
ARG UNSPLASH_KEY=DUMMY_UNSPLASH_KEY
ARG UNSPLASH_CLIENT_ID=DUMMY_UNSPLASH_CLIENT_ID

# Set as environment variables for the build
ENV UNSPLASH_KEY=$UNSPLASH_KEY
ENV UNSPLASH_CLIENT_ID=$UNSPLASH_CLIENT_ID

WORKDIR /app

# Install git and configure for HTTPS
# Use single apt-get command to avoid GPG issues
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
    --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://github.com/".insteadOf ssh://git@github.com/

# Copy and install dependencies
COPY package*.json ./
COPY packages/sync-core/package*.json ./packages/sync-core/
COPY packages/sync-core/tsconfig*.json ./packages/sync-core/
COPY packages/sync-core/tsup.config.ts ./packages/sync-core/
COPY packages/sync-core/src ./packages/sync-core/src
COPY packages/sync-providers/package*.json ./packages/sync-providers/
COPY packages/sync-providers/tsconfig*.json ./packages/sync-providers/
COPY packages/sync-providers/tsup.config.ts ./packages/sync-providers/
COPY packages/sync-providers/src ./packages/sync-providers/src
COPY packages/plugin-api/package*.json ./packages/plugin-api/
COPY packages/plugin-api/tsconfig.json ./packages/plugin-api/
COPY packages/plugin-api/src ./packages/plugin-api/src
COPY packages/shared-schema/package*.json ./packages/shared-schema/
COPY packages/shared-schema/tsconfig.json ./packages/shared-schema/
COPY packages/shared-schema/tsup.config.ts ./packages/shared-schema/
COPY packages/shared-schema/src ./packages/shared-schema/src
COPY tsconfig.json ./
COPY tools/ ./tools/
# Package downloads come from one cache shared by every image's build (anex/build-memory), so a package is
# downloaded once rather than once per install. The cache lives with the builder, never in the image.
RUN --mount=type=cache,id=sp-npm,target=/root/.npm npm ci --ignore-scripts || npm i --ignore-scripts
RUN npm run prepare

# Copy source and build.
#
# The excluded paths are deployment config, consumed only by the runtime stage
# below (or by nothing in the image at all). Without these exclusions they sit
# in this layer's cache key, so editing an nginx directive or one line of the
# entrypoint invalidates it and forces a full ~10-minute Angular rebuild for a
# change that never reaches the compiled app.
COPY --exclude=nginx \
     --exclude=docker-entrypoint.sh \
     --exclude=docker \
     --exclude=documentation \
     . .
# Pass build args as environment variables for the build commands.
#
# Lint deliberately does NOT run here. It cost 76s of every image build, and a
# container build is the wrong place to discover a style error — it fails after
# the expensive layers instead of before them. The gate lives in
# .github/workflows/publish-containers.yml, where it blocks all six image builds
# up front and costs a local build nothing.
#
# Heap limit for the Angular build (anex/build-memory). Without one, Node sizes
# its heap from the host's memory (about 4 GB here) and lets garbage pile up
# until near it: measured at 4.4 GB for ng build, plus 1.7 GB for its esbuild
# process, leaving 1.1 GB free on an 11 GB build host. If the build ever stops
# with "JavaScript heap out of memory", it needs more than this: raise it.
#
# The build also installs each bundled plugin's packages (build-packages.js,
# for every plugin without a node_modules folder, which the build context never
# carries); those downloads use the same shared cache as the install above.
RUN --mount=type=cache,id=sp-npm,target=/root/.npm \
    UNSPLASH_KEY=$UNSPLASH_KEY UNSPLASH_CLIENT_ID=$UNSPLASH_CLIENT_ID npm run env \
 && NODE_OPTIONS=--max-old-space-size=3072 npm run buildFrontend:prodWeb

# Production stage
FROM nginx:1

ENV APP_PORT=80

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends jq curl && rm -rf /var/lib/apt/lists/*

# Copy built app and configs
COPY --from=build /app/dist/browser /usr/share/nginx/html
COPY ./nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE $APP_PORT
WORKDIR /usr/share/nginx/html

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
