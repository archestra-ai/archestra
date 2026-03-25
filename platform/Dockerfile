# Build KinD and Docker CLI from source with a patched Go toolchain.
# The Alpine packages/binaries have historically lagged on Go patch releases, so
# we compile these tools ourselves to pick up upstream fixes without local vendoring hacks.
ARG GOLANG_IMAGE=golang:1.25.8-alpine@sha256:8e02eb337d9e0ea459e041f1ee5eece41cbb61f1d83e7d883a3e2fb4862063fa
ARG NODE_IMAGE=node:24-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114
ARG KIND_VERSION=v0.31.0
ARG KIND_COMMIT=a323333ff9efd8099f95a8a6b5c86c75a210d00f
ARG DOCKER_CLI_VERSION=v29.3.0
ARG DOCKER_CLI_COMMIT=5927d80c76b3ce5cf782be818922966e8a0d87a3

FROM ${GOLANG_IMAGE} AS go-builder
ARG TARGETARCH
ARG KIND_VERSION
ARG KIND_COMMIT
ARG DOCKER_CLI_VERSION
ARG DOCKER_CLI_COMMIT
RUN if [ "$TARGETARCH" != "amd64" ] && [ "$TARGETARCH" != "arm64" ]; then \
        echo "ERROR: Unsupported architecture: $TARGETARCH. KinD is only available for amd64 and arm64."; \
        exit 1; \
    fi
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${KIND_VERSION}" https://github.com/kubernetes-sigs/kind.git /kind && \
    test "$(git -C /kind rev-parse HEAD)" = "${KIND_COMMIT}" && \
    cd /kind && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -o /kind-binary .
RUN git clone --depth 1 --branch "${DOCKER_CLI_VERSION}" https://github.com/docker/cli.git /docker-cli && \
    test "$(git -C /docker-cli rev-parse HEAD)" = "${DOCKER_CLI_COMMIT}" && \
    cd /docker-cli && \
    cp vendor.mod go.mod && cp vendor.sum go.sum && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -mod=vendor \
    -ldflags "-X github.com/docker/cli/cli/version.Version=${DOCKER_CLI_VERSION#v}" \
    -o /docker-binary ./cmd/docker

FROM ${NODE_IMAGE} AS base

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN corepack prepare pnpm@10.33.0 --activate

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy package files for all workspaces
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY shared/package.json shared/
COPY patches/ patches/

# Install all dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# <----- Builder stage ----->
FROM base AS builder
WORKDIR /app

# Version arg for Sentry release tracking
ARG VERSION=dev

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules

# Copy source files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared

# Build all workspace
ENV NEXT_TELEMETRY_DISABLED=1

# VERSION is exported as env var for child processes (used by Sentry source map upload)
ENV VERSION=${VERSION}

# Use Docker secrets to securely pass various sensitive environment variables during build
# These environment variables are NOT persisted in the final image
#
# TURBO_TEAM and TURBO_TOKEN are used for Turbo remote caching
# https://turborepo.com/docs/guides/tools/docker#example
#
# SENTRY_AUTH_TOKEN is used by backend/frontend builds to upload source maps
# SENTRY_URL points to the EU region where the archestra org is hosted
#
# https://docs.docker.com/build/building/secrets/#using-build-secrets
# https://docs.docker.com/build/building/secrets/#target
RUN --mount=type=secret,id=turbo_team,env=TURBO_TEAM \
    --mount=type=secret,id=turbo_token,env=TURBO_TOKEN \
    --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    SENTRY_URL=https://de.sentry.io/ \
    pnpm build

# <----- Final unified stage ----->
FROM base AS unified
WORKDIR /app

ARG VERSION=dev

ENV NODE_ENV=production
# disable telemetry for next.js
ENV NEXT_TELEMETRY_DISABLED=1

ENV ARCHESTRA_VERSION=${VERSION}
ENV ARCHESTRA_INTERNAL_API_BASE_URL="http://localhost:9000"
ENV ARCHESTRA_API_BASE_URL=""
ENV ARCHESTRA_ANALYTICS="enabled"
ENV ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED="false"
ENV ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING="false"
ENV ARCHESTRA_SENTRY_FRONTEND_DSN=""
ENV ARCHESTRA_SENTRY_ENVIRONMENT=""

# Cloud database CA bundle for SSL certificate validation
# This allows sslmode=require to work with AWS RDS and Google Cloud SQL
ENV NODE_EXTRA_CA_CERTS="/etc/ssl/certs/cloud-database-ca-bundle.pem"

# Vendor cloud database CA bundles into the repository so image builds do not
# depend on live network fetches for trust roots.
COPY docker/certs/aws-rds-global-bundle.pem /tmp/aws-rds-ca.pem
COPY docker/certs/gcloud-sql-global.pem /tmp/gcloud-sql-ca.pem

RUN apk --no-cache upgrade && \
    # Install PostgreSQL 17, pgvector, and supervisord
    apk add --no-cache postgresql17=17.9-r0 postgresql17-contrib=17.9-r0 postgresql-pgvector su-exec && \
    # Combine all CA bundles
    cat /tmp/aws-rds-ca.pem /tmp/gcloud-sql-ca.pem > /etc/ssl/certs/cloud-database-ca-bundle.pem && \
    rm -f /tmp/aws-rds-ca.pem /tmp/gcloud-sql-ca.pem && \
    # Remove NPM-related files and directories (as we do not use npm and it just brings extra dependencies/vulnerabilities)
    # See https://github.com/grafana/grafana-image-renderer/pull/625
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -rf /usr/local/bin/npm && \
    rm -rf /usr/local/bin/npx && \
    rm -rf /root/.npm && \
    rm -rf /root/.node-gyp && \
    mkdir -p /var/log/supervisor && \
    # Clean up
    rm -rf /tmp/*

# Install KinD (Kubernetes in Docker) and docker-cli for embedded K8s cluster support
# Both binaries are built from source in go-builder with Go 1.25.8 to fix CVE-2025-68121
COPY --from=go-builder /docker-binary /usr/local/bin/docker
COPY --from=go-builder /kind-binary /usr/local/bin/kind
RUN chmod +x /usr/local/bin/kind /usr/local/bin/docker
# TODO: Once KinD releases a version compiled with Go >= 1.25.8, remove the kind-builder stage
# at the top of this file and restore the pre-built binary download below for faster builds.
# Track releases at: https://github.com/kubernetes-sigs/kind/releases
# RUN ARCH=$(uname -m) && \
#     if [ "$ARCH" = "x86_64" ]; then \
#         KIND_URL="https://kind.sigs.k8s.io/dl/v0.31.0/kind-linux-amd64"; \
#         KIND_SHA256="eb244cbafcc157dff60cf68693c14c9a75c4e6e6fedaf9cd71c58117cb93e3fa"; \
#     elif [ "$ARCH" = "aarch64" ]; then \
#         KIND_URL="https://kind.sigs.k8s.io/dl/v0.31.0/kind-linux-arm64"; \
#         KIND_SHA256="8e1014e87c34901cc422a1445866835d1e666f2a61301c27e722bdeab5a1f7e4"; \
#     else \
#         echo "ERROR: Unsupported architecture: $ARCH. KinD is only available for x86_64 and aarch64."; \
#         exit 1; \
#     fi && \
#     wget -O /usr/local/bin/kind "${KIND_URL}" && \
#     echo "${KIND_SHA256}  /usr/local/bin/kind" | sha256sum -c - && \
#     chmod +x /usr/local/bin/kind

RUN apk add --no-cache supervisor

# Create postgres directories (user already exists from postgresql package)
RUN mkdir -p /var/lib/postgresql/data /run/postgresql && \
    chown -R postgres:postgres /var/lib/postgresql /run/postgresql

# Mark PostgreSQL data directory as a volume for data persistence
VOLUME /var/lib/postgresql/data /app/data

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY patches/ patches/
COPY docker/scripts/docker-banner.sh /app/docker-banner.sh
COPY docker/scripts/docker-entrypoint.sh /docker-entrypoint.sh
COPY docker/supervisord/supervisord.conf /etc/supervisord.conf
COPY docker/supervisord/postgres.conf /etc/supervisord.postgres.conf

# Install production dependencies for both workspaces
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter=@backend --filter=@frontend

# Copy built backend
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/scripts ./backend/scripts
COPY --from=builder /app/backend/drizzle.config.ts ./backend/
COPY --from=builder /app/backend/src/database/migrations ./backend/src/database/migrations
RUN chmod +x /app/backend/scripts/start-production.sh

# Copy built frontend
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/.next/standalone ./

# Copy previous version's static assets first (from CI build context)
# Content-hashed filenames ensure no conflicts between versions
COPY prev-static-assets/ ./frontend/.next/static/

# Copy current build's assets on top
COPY --from=builder /app/frontend/.next/static ./frontend/.next/static

# Keep a clean copy of ONLY this build's assets (not accumulated)
# CI will extract from this path for the NEXT deployment
COPY --from=builder /app/frontend/.next/static /static-assets-source/

RUN chmod +x /docker-entrypoint.sh
RUN chmod +x /app/docker-banner.sh

# Expose ports
EXPOSE 5432 9000 9050 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
