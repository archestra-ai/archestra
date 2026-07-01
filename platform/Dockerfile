# build KinD, Docker CLI, Dagger CLI, and kubectl from source with a patched Go toolchain.
# the Alpine packages/binaries have historically lagged on Go patch releases, so
# we compile these tools ourselves to pick up upstream fixes without local vendoring hacks.
ARG GOLANG_IMAGE=golang:1.26.4-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648
ARG NODE_IMAGE=node:24-alpine3.23@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14
ARG KIND_VERSION=v0.31.0
ARG KIND_COMMIT=a323333ff9efd8099f95a8a6b5c86c75a210d00f
ARG DOCKER_CLI_VERSION=v29.3.0
ARG DOCKER_CLI_COMMIT=5927d80c76b3ce5cf782be818922966e8a0d87a3
ARG DAGGER_VERSION=v0.21.5
ARG DAGGER_COMMIT=c7a5ecd0d0c2fb3e6609e167325fb70a51a5c2b8
ARG KUBECTL_VERSION=v1.35.0
ARG KUBECTL_COMMIT=66452049f3d692768c39c797b21b793dce80314e

FROM ${GOLANG_IMAGE} AS go-builder
ARG TARGETARCH
ARG KIND_VERSION
ARG KIND_COMMIT
ARG DOCKER_CLI_VERSION
ARG DOCKER_CLI_COMMIT
ARG DAGGER_VERSION
ARG DAGGER_COMMIT
ARG KUBECTL_VERSION
ARG KUBECTL_COMMIT
RUN if [ "$TARGETARCH" != "amd64" ] && [ "$TARGETARCH" != "arm64" ]; then \
        echo "ERROR: Unsupported architecture: $TARGETARCH. KinD is only available for amd64 and arm64."; \
        exit 1; \
    fi
RUN apk add --no-cache git
COPY docker/dagger-dockercompat /dagger-dockercompat
RUN git clone --depth 1 --branch "${KIND_VERSION}" https://github.com/kubernetes-sigs/kind.git /kind && \
    test "$(git -C /kind rev-parse HEAD)" = "${KIND_COMMIT}" && \
    cd /kind && \
    go mod edit -go=1.25.11 && \
    # golang.org/x/net <0.55.0: CVE-2026-39821 (CRITICAL); fixed in >= 0.55.0
    go get golang.org/x/net@v0.55.0 && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -o /kind-binary .
RUN git clone --depth 1 --branch "${DOCKER_CLI_VERSION}" https://github.com/docker/cli.git /docker-cli && \
    test "$(git -C /docker-cli rev-parse HEAD)" = "${DOCKER_CLI_COMMIT}" && \
    cd /docker-cli && \
    cp vendor.mod go.mod && cp vendor.sum go.sum && \
    go mod edit -go=1.25.11 && \
    # CVE-2026-33186: grpc Improper Authorization fixed in >= 1.79.3
    go get google.golang.org/grpc@v1.79.3 && \
    # CVE-2026-39883: OTel SDK untrusted search path fixed in >= 1.43.0
    go get go.opentelemetry.io/otel/sdk@v1.43.0 && \
    # CVE-2026-34986: go-jose uncaught exception fixed in >= 4.1.4
    go get github.com/go-jose/go-jose/v4@v4.1.4 && \
    # x/sys/x/term must be pinned for `go mod vendor` to find windows/registry and plan9 sub-pkgs.
    # Versions must satisfy x/net@v0.55.0 requirements: x/sys >= v0.45.0, x/term >= v0.43.0.
    go get golang.org/x/sys@v0.45.0 && \
    go get golang.org/x/term@v0.43.0 && \
    # golang.org/x/net <0.55.0: CVE-2026-39821 (CRITICAL); fixed in >= 0.55.0.
    # Must be the LAST `go get` before `go mod vendor` — earlier `go get`s for grpc/otel/x/sys
    # transitively pull older x/net and would otherwise override our explicit requirement.
    go get golang.org/x/net@v0.55.0 && \
    go mod vendor && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -mod=vendor \
    -ldflags "-X github.com/docker/cli/cli/version.Version=${DOCKER_CLI_VERSION#v}" \
    -o /docker-binary ./cmd/docker
RUN git clone --depth 1 --branch "${DAGGER_VERSION}" https://github.com/dagger/dagger.git /dagger && \
    test "$(git -C /dagger rev-parse HEAD)" = "${DAGGER_COMMIT}" && \
    cd /dagger && \
    cp -R /dagger-dockercompat ./dockercompat && \
    # dagger v0.21.5's vendored Go SDK requires go >= 1.26.1; align the module directive.
    go mod edit -go=1.26.1 && \
    # cve-2026-34040: replace Dagger's BuildKit Docker monolith imports with split Moby modules.
    go mod edit -require=github.com/docker/docker@v29.3.1+incompatible && \
    go mod edit -replace=github.com/docker/docker=./dockercompat && \
    # cve-2026-34986: go-jose uncaught exception fixed in >= 4.1.4
    go get github.com/go-jose/go-jose/v4@v4.1.4 && \
    # cve-2026-45022: go-git validation issue fixed in >= 5.19.0
    go get github.com/go-git/go-git/v5@v5.19.0 && \
    # cve-2026-44973: go-billy path traversal fixed in >= 5.9.0
    go get github.com/go-git/go-billy/v5@v5.9.0 && \
    # cve-2026-39821: x/net CRITICAL fixed in >= 0.55.0
    go get golang.org/x/net@v0.55.0 && \
    # cve-2026-46597: x/crypto issue fixed in >= 0.52.0; keep this after x/net.
    go get golang.org/x/crypto@v0.52.0 && \
    go get github.com/moby/go-archive@v0.2.0 github.com/moby/profiles/seccomp@v0.2.3 github.com/moby/sys/reexec@v0.1.0 github.com/moby/sys/user@v0.4.0 && \
    # cve-2026-46680: containerd type confusion fixed in >= 2.2.4
    # cve-2026-53488/53492/53489: containerd injection/input-validation/symlink-following fixed in >= 2.2.5
    # Must be the LAST `go get` before `go mod tidy` — earlier `go get`s (go-git/go-billy/moby)
    # transitively pull containerd 2.2.4 and would otherwise downgrade our explicit requirement.
    go get github.com/containerd/containerd/v2@v2.2.5 && \
    go mod tidy && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -ldflags "-X github.com/dagger/dagger/engine.Version=${DAGGER_VERSION} -X github.com/dagger/dagger/engine.Tag=${DAGGER_VERSION}" \
    -o /dagger-binary ./cmd/dagger
RUN git clone --depth 1 --branch "${KUBECTL_VERSION}" https://github.com/kubernetes/kubernetes.git /kubernetes && \
    test "$(git -C /kubernetes rev-parse HEAD)" = "${KUBECTL_COMMIT}" && \
    cd /kubernetes && \
    go mod edit -go=1.25.11 && \
    go work edit -go=1.25.11 && \
    # cve-2026-35469: spdystream resource exhaustion fixed in >= 0.5.1.
    go get github.com/moby/spdystream@v0.5.1 && \
    # cve-2026-29181: OTel resource exhaustion fixed in >= 1.41.0.
    go get go.opentelemetry.io/otel@v1.41.0 go.opentelemetry.io/otel/metric@v1.41.0 go.opentelemetry.io/otel/trace@v1.41.0 go.opentelemetry.io/otel/sdk@v1.41.0 && \
    # cve-2026-39821: x/net CRITICAL fixed in >= 0.55.0.
    go get golang.org/x/net@v0.55.0 && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -mod=readonly \
    -ldflags "-X k8s.io/component-base/version.gitVersion=${KUBECTL_VERSION} -X k8s.io/component-base/version.gitCommit=${KUBECTL_COMMIT} -X k8s.io/component-base/version.gitTreeState=clean" \
    -o /kubectl-binary ./cmd/kubectl

# render the quickstart Dagger Engine manifest from the helm/dagger-runtime chart
# at build time (offline — the subchart is vendored in charts/). rendering here
# instead of committing a snapshot keeps it in lockstep with the chart used in
# prod/dev. laptop-sized resources so the embedded KinD cluster can schedule it;
# kube-pod:// transport needs no Service/TCP listener.
FROM ${NODE_IMAGE} AS dagger-manifest
RUN apk add --no-cache helm
COPY helm/dagger-runtime /chart/dagger-runtime
RUN helm template dagger-runtime /chart/dagger-runtime --namespace default \
        --set networkPolicy.create=false \
        --set dagger.engine.resources.requests.cpu=500m \
        --set dagger.engine.resources.requests.memory=2Gi \
        --set dagger.engine.resources.limits.memory=6Gi \
        --set dagger.engine.statefulSet.persistentVolumeClaim.resources.requests.storage=20Gi \
        > /dagger-engine.quickstart.yaml

# pre-bake the Dagger Engine image as a docker-archive so the quickstart can
# kind-load it into the embedded node instead of pulling ~352MB from the registry
# on every boot (KinD recreates its node each run and its containerd cannot see
# the host Docker image cache). tagged to match the engine ref the rendered
# manifest uses, so imagePullPolicy: IfNotPresent finds it locally.
FROM ${NODE_IMAGE} AS dagger-engine-image
ARG TARGETARCH
ARG DAGGER_VERSION
RUN apk add --no-cache skopeo
RUN skopeo copy --override-os linux --override-arch "${TARGETARCH}" \
        "docker://registry.dagger.io/engine:${DAGGER_VERSION}" \
        "docker-archive:/dagger-engine.tar:registry.dagger.io/engine:${DAGGER_VERSION}"

FROM ${NODE_IMAGE} AS base

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN corepack prepare pnpm@11.9.0 --activate

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy package files for all workspaces
# pnpm-workspace.yaml contains pnpm v11 project settings.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY shared/package.json shared/
COPY archestra-rs/sandbox-rs/package.json archestra-rs/sandbox-rs/
COPY archestra-rs/app-runtime-rs/package.json archestra-rs/app-runtime-rs/

# Install all dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# CVE-2026-33671: Next.js bundles picomatch 4.0.3 at dist/compiled/picomatch/.
# pnpm overrides cannot reach this vendored copy; upstream has not re-vendored
# yet (tracked at vercel/next.js#92950). Replace it with the 4.0.4 package tree.
# The path resolves through the symlink frontend/node_modules/next → .pnpm/next@.../node_modules/next,
# so overwriting once updates every reference.
RUN set -eux; \
    cd /tmp; \
    wget -q -O picomatch-4.0.4.tgz https://registry.npmjs.org/picomatch/-/picomatch-4.0.4.tgz; \
    echo "515b5ab666558ed9a117483a310892aede54a68dd78f2d8db6604513e578571c  picomatch-4.0.4.tgz" | sha256sum -c -; \
    target=/app/frontend/node_modules/next/dist/compiled/picomatch; \
    rm -rf "$target"/*; \
    tar -xzf picomatch-4.0.4.tgz --strip-components=1 -C "$target"; \
    rm -f picomatch-4.0.4.tgz; \
    grep -q '"version": "4.0.4"' "$target/package.json"

# <----- Builder base stage ----->
FROM base AS builder-base
WORKDIR /app

# Version arg for Sentry release tracking
ARG VERSION=dev

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/archestra-rs/sandbox-rs/node_modules ./archestra-rs/sandbox-rs/node_modules
COPY --from=deps /app/archestra-rs/app-runtime-rs/node_modules ./archestra-rs/app-runtime-rs/node_modules

# Copy source files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared
COPY archestra-rs/Cargo.toml archestra-rs/Cargo.lock ./archestra-rs/
COPY archestra-rs/sandbox-core ./archestra-rs/sandbox-core
COPY archestra-rs/sandbox-rs ./archestra-rs/sandbox-rs
COPY archestra-rs/app-runtime-core ./archestra-rs/app-runtime-core
COPY archestra-rs/app-runtime-rs ./archestra-rs/app-runtime-rs

# Build the Rust N-API skill sandbox addon during the JS workspace build.
RUN apk add --no-cache build-base cargo rust

# Build all workspace
ENV NEXT_TELEMETRY_DISABLED=1

# VERSION is exported as env var for child processes (used by Sentry source map upload)
ENV VERSION=${VERSION}

FROM builder-base AS rust-napi-musl-smoke
# cache cargo registry/git + the workspace target dir so heavy deps
# (dagger-sdk, tokio, …) aren't recompiled on every build of this stage.
# Smokes every N-API addon under musl: build the .node, then load and call it so
# a musl-specific loader/linkage regression fails here rather than at runtime.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/app/archestra-rs/target \
    pnpm --filter @archestra/sandbox-rs --filter @archestra/app-runtime-rs check:musl

# <----- Builder stage ----->
FROM builder-base AS builder

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
# Cache cargo registry/git, the Rust workspace target dir, turbo's local cache,
# and Next.js's build cache so a cold `pnpm build` (which recompiles the Rust
# N-API addon and builds the frontend) reuses prior work on subsequent builds.
# The cargo targets match the rust-napi-musl-smoke stage above, so that stage
# warms the registry for this one; cargo isolates artifacts by target triple.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/app/archestra-rs/target \
    --mount=type=cache,target=/app/.turbo \
    --mount=type=cache,target=/app/frontend/.next/cache \
    --mount=type=secret,id=turbo_team,env=TURBO_TEAM \
    --mount=type=secret,id=turbo_token,env=TURBO_TOKEN \
    --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    SENTRY_URL=https://de.sentry.io/ \
    pnpm build

# <----- Final unified stage ----->
FROM base AS unified
WORKDIR /app

ARG VERSION=dev
ARG TARGETARCH

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
    # Install PostgreSQL 17, pgvector, supervisord, and git.
    # The skill-marketplace clone endpoint needs the git CLI (materialize.ts) and
    # git-http-backend, the smart-HTTP CGI — which Alpine ships in git-daemon, not git.
    apk add --no-cache postgresql17 postgresql17-contrib postgresql-pgvector su-exec git git-daemon && \
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

# install KinD (Kubernetes in Docker), docker-cli, and kubectl for Kubernetes runtime support
# these binaries are built from source in go-builder with Go 1.26.4 to fix CVE-2025-68121,
# the Go stdlib HIGH CVEs fixed in 1.25.10 (CVE-2026-42499/39836/39820/33814/33811), and
# the Go stdlib HIGH CVE fixed in 1.25.11 (CVE-2026-42504).
COPY --from=go-builder /docker-binary /usr/local/bin/docker
COPY --from=go-builder /kind-binary /usr/local/bin/kind
COPY --from=go-builder /kubectl-binary /usr/local/bin/kubectl
RUN chmod +x /usr/local/bin/kind /usr/local/bin/docker /usr/local/bin/kubectl
# TODO: Once KinD releases a version compiled with Go >= 1.25.11, remove the kind-builder stage
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

# install the Dagger CLI. The Rust dagger-sdk used by the N-API sandbox addon needs it to open a session
# to the Dagger Engine; its npm postinstall download is blocked by
# ignore-scripts, so the binary is pinned and built from source above.
# keep DAGGER_VERSION in sync with dagger-sdk in archestra-rs/sandbox-core/Cargo.toml.
COPY --from=go-builder /dagger-binary /usr/local/bin/dagger
RUN chmod +x /usr/local/bin/dagger
# point the SDK at the baked-in CLI so it never downloads one at runtime.
ENV _EXPERIMENTAL_DAGGER_CLI_BIN=/usr/local/bin/dagger

RUN apk add --no-cache supervisor && \
    # CVE-2026-24049: wheel 0.45.1 path traversal. Vendored inside py3-setuptools
    # (pulled in by supervisor); pip can't upgrade the vendored copy, so delete it.
    rm -rf /usr/lib/python*/site-packages/setuptools/_vendor/wheel \
           /usr/lib/python*/site-packages/setuptools/_vendor/wheel-*.dist-info \
           /usr/lib/python*/ensurepip

# Create postgres directories (user already exists from postgresql package)
RUN mkdir -p /var/lib/postgresql/data /run/postgresql && \
    chown -R postgres:postgres /var/lib/postgresql /run/postgresql

# Mark PostgreSQL data directory as a volume for data persistence
VOLUME /var/lib/postgresql/data /app/data

# Copy package files
# pnpm-workspace.yaml contains pnpm v11 project settings.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY archestra-rs/sandbox-rs/package.json archestra-rs/sandbox-rs/
COPY archestra-rs/app-runtime-rs/package.json archestra-rs/app-runtime-rs/
COPY docker/scripts/docker-banner.sh /app/docker-banner.sh
COPY docker/scripts/docker-entrypoint.sh /docker-entrypoint.sh
# slim Dagger Engine manifest (rendered in the dagger-manifest stage above)
# applied into the embedded KinD cluster in quickstart mode; backs the skill
# sandbox / code runtime (archestra__run_command and friends).
COPY --from=dagger-manifest /dagger-engine.quickstart.yaml /app/dagger-engine.quickstart.yaml
# engine image baked in (kind-loaded into the node at boot to avoid a registry pull)
COPY --from=dagger-engine-image /dagger-engine.tar /app/dagger-engine.tar
COPY docker/supervisord/supervisord.conf /etc/supervisord.conf
COPY docker/supervisord/postgres.conf /etc/supervisord.postgres.conf

# Install production dependencies for both workspaces
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter=@backend --filter=@frontend

# CVE-2026-33671: replace Next's bundled picomatch 4.0.3 with 4.0.4 (same as deps stage).
# Production install refetches next so the patched copy from the builder is not inherited.
RUN set -eux; \
    cd /tmp; \
    wget -q -O picomatch-4.0.4.tgz https://registry.npmjs.org/picomatch/-/picomatch-4.0.4.tgz; \
    echo "515b5ab666558ed9a117483a310892aede54a68dd78f2d8db6604513e578571c  picomatch-4.0.4.tgz" | sha256sum -c -; \
    target=/app/frontend/node_modules/next/dist/compiled/picomatch; \
    rm -rf "$target"/*; \
    tar -xzf picomatch-4.0.4.tgz --strip-components=1 -C "$target"; \
    rm -f picomatch-4.0.4.tgz; \
    grep -q '"version": "4.0.4"' "$target/package.json"

# CVE-2026-12151: corepack's cached pnpm bundles undici 6.26.0 (<6.27.0) at
# /root/.cache/node/corepack/.../dist/node_modules/undici — pnpm overrides cannot
# reach it. pnpm is only needed at build time (the prod install above); runtime DB
# migrations call drizzle-kit directly (see docker/supervisord/supervisord.conf),
# so drop corepack/pnpm from the final image entirely.
RUN rm -rf /root/.cache/node/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

# Copy built backend
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/scripts ./backend/scripts
COPY --from=builder /app/backend/drizzle.config.ts ./backend/
COPY --from=builder /app/backend/src/database/migrations ./backend/src/database/migrations
COPY --from=builder /app/archestra-rs/sandbox-rs/index.cjs ./archestra-rs/sandbox-rs/
COPY --from=builder /app/archestra-rs/sandbox-rs/index.d.ts ./archestra-rs/sandbox-rs/
COPY --from=builder /app/archestra-rs/sandbox-rs/*.node ./archestra-rs/sandbox-rs/
COPY --from=builder /app/archestra-rs/app-runtime-rs/index.cjs ./archestra-rs/app-runtime-rs/
COPY --from=builder /app/archestra-rs/app-runtime-rs/index.d.ts ./archestra-rs/app-runtime-rs/
COPY --from=builder /app/archestra-rs/app-runtime-rs/*.node ./archestra-rs/app-runtime-rs/
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
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
