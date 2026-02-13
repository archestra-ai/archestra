# Build KinD and Docker CLI from source with Go 1.25.7 to fix CVE-2025-61726, CVE-2025-68121
# Alpine 3.23 only has Go 1.25.6, so we use the official golang image for 1.25.7+
# KinD v0.31.0 pre-built binaries use Go 1.25.5 which has the vulnerability
# Alpine 3.23's docker-cli (29.1.3) is compiled with Go 1.25.6 (vulnerable to CVE-2025-68121)
FROM golang:1.25.7-alpine AS go-builder
ARG TARGETARCH
RUN if [ "$TARGETARCH" != "amd64" ] && [ "$TARGETARCH" != "arm64" ]; then \
        echo "ERROR: Unsupported architecture: $TARGETARCH. KinD is only available for amd64 and arm64."; \
        exit 1; \
    fi
RUN apk add --no-cache git
RUN git clone --depth 1 --branch v0.31.0 https://github.com/kubernetes-sigs/kind.git /kind && \
    cd /kind && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -o /kind-binary .
RUN git clone --depth 1 --branch v29.1.3 https://github.com/docker/cli.git /docker-cli && \
    cd /docker-cli && \
    cp vendor.mod go.mod && cp vendor.sum go.sum && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -mod=vendor \
    -ldflags '-X github.com/docker/cli/cli/version.Version=29.1.3' \
    -o /docker-binary ./cmd/docker

FROM node:24-alpine3.23 AS base

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Patch CVE-2026-23745: tar <=7.5.2 has path traversal vulnerability
# Patch CVE-2026-23950: tar <=7.5.3 has Improper Handling of Unicode Encoding
# Patch CVE-2026-24842: tar <=7.5.6 has path traversal vulnerability
# tar is bundled in pnpm's corepack distribution and needs to be patched
# Patch ALL pnpm versions in corepack cache to ensure comprehensive fix
RUN corepack prepare pnpm@10.29.3 --activate && \
    TAR_SHA256="87355a4cb10e7e7cdb4326e3e3c89232eaf5266d0792b998a396ddf6c11502bb" && \
    PNPM_TAR_PATHS=$(find /root/.cache/node/corepack -path "*/pnpm/*/dist/node_modules/tar" -type d 2>/dev/null) && \
    [ -n "$PNPM_TAR_PATHS" ] || { echo "WARNING: No tar directories found to patch"; exit 0; } && \
    for PNPM_TAR_PATH in $PNPM_TAR_PATHS; do \
        echo "Patching tar in $PNPM_TAR_PATH" && \
        TMP_DIR=$(mktemp -d) && \
        wget -qO "$TMP_DIR/tar.tgz" https://registry.npmjs.org/tar/-/tar-7.5.7.tgz && \
        echo "$TAR_SHA256  $TMP_DIR/tar.tgz" | sha256sum -c - || { echo "ERROR: checksum mismatch"; rm -rf "$TMP_DIR"; exit 1; } && \
        tar -tzf "$TMP_DIR/tar.tgz" >/dev/null 2>&1 || { echo "ERROR: Downloaded tarball is corrupt"; rm -rf "$TMP_DIR"; exit 1; } && \
        rm -rf "$PNPM_TAR_PATH"/* && \
        tar -xzf "$TMP_DIR/tar.tgz" -C "$PNPM_TAR_PATH" --strip-components=1 && \
        rm -rf "$TMP_DIR"; \
    done && \
    echo "Patched tar to 7.5.7 in all pnpm corepack caches"

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy package files for all workspaces
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY shared/package.json shared/

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
#
# https://docs.docker.com/build/building/secrets/#using-build-secrets
# https://docs.docker.com/build/building/secrets/#target
RUN --mount=type=secret,id=turbo_team,env=TURBO_TEAM \
    --mount=type=secret,id=turbo_token,env=TURBO_TOKEN \
    --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
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
ENV ARCHESTRA_AUTH_DISABLE_BASIC_AUTH="false"
ENV ARCHESTRA_AUTH_DISABLE_INVITATIONS="false"
ENV ARCHESTRA_SENTRY_FRONTEND_DSN=""
ENV ARCHESTRA_SENTRY_ENVIRONMENT=""

# Cloud database CA bundle for SSL certificate validation
# This allows sslmode=require to work with AWS RDS and Google Cloud SQL
ENV NODE_EXTRA_CA_CERTS="/etc/ssl/certs/cloud-database-ca-bundle.pem"

RUN apk --no-cache upgrade && \
    # Install PostgreSQL 17, supervisord, and wget (needed for KinD download and health checks)
    apk add --no-cache postgresql17 postgresql17-contrib su-exec wget && \
    # Download cloud database CA bundles for SSL certificate validation
    # AWS RDS global CA bundle
    wget -qO /tmp/aws-rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem && \
    # Google Cloud SQL global CA bundle
    wget -qO /tmp/gcloud-sql-ca.pem https://storage.googleapis.com/cloudsql-ca-bundles/global.pem && \
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
# Both binaries are built from source in go-builder with Go 1.25.7 to fix CVE-2025-68121
COPY --from=go-builder /docker-binary /usr/local/bin/docker
COPY --from=go-builder /kind-binary /usr/local/bin/kind
RUN chmod +x /usr/local/bin/kind /usr/local/bin/docker
# TODO: Once KinD releases a version compiled with Go >= 1.25.7, remove the kind-builder stage
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

# Install supervisor from edge repository to address CVE-2023-27482
# https://nvd.nist.gov/vuln/detail/cve-2023-27482
RUN apk add --no-cache supervisor=4.3.0-r0 --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main && \
    # CVE-2026-24049: Path Traversal vulnerability in wheel <= 0.46.1
    # Supervisor brings in Python/wheel as dependencies, upgrade wheel to fix CVE
    # Install py3-pip (required for pip command) and upgrade wheel
    apk add --no-cache py3-pip && \
    pip install --upgrade "wheel>=0.46.2" --break-system-packages && \
    # Also remove vendored vulnerable wheel from setuptools (py3-setuptools bundles wheel 0.45.1)
    rm -rf /usr/lib/python3.12/site-packages/setuptools/_vendor/wheel /usr/lib/python3.12/site-packages/setuptools/_vendor/wheel-*.dist-info

# Create postgres directories (user already exists from postgresql package)
RUN mkdir -p /var/lib/postgresql/data /run/postgresql && \
    chown -R postgres:postgres /var/lib/postgresql /run/postgresql

# Mark PostgreSQL data directory as a volume for data persistence
VOLUME /var/lib/postgresql/data /app/data

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY docker-banner.sh ./

# Install production dependencies for both workspaces
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter=@backend --filter=@frontend

# Copy built backend
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/drizzle.config.ts ./backend/
COPY --from=builder /app/backend/src/database/migrations ./backend/src/database/migrations

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

# Create base supervisord configuration (without postgres)
#
# Important notes about supervisord environment variable handling:
# - Subprocesses automatically inherit ALL environment variables from the shell that starts supervisord
#   See: https://supervisord.org/subprocess.html#subprocess-environment
# - You ONLY need to explicitly set environment variables in the config when:
#   1. Using placeholder substitution (e.g., DATABASE_URL="placeholder" that gets replaced via sed)
#   2. Mapping ENV variables to different names (e.g., ARCHESTRA_* -> NEXT_PUBLIC_*)
#   3. Setting hardcoded values not in ENV (e.g., HOSTNAME="0.0.0.0")
# - All ENV variables declared in the Dockerfile are automatically available to all programs
#   See: https://supervisord.org/configuration.html#supervisord-section-values
RUN cat > /etc/supervisord.conf <<'EOF'
[supervisord]
nodaemon=true
user=root
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/supervisord.pid

[program:backend]
directory=/app/backend
command=/bin/sh -c "sleep 5 && pnpm db:migrate && node dist/server.mjs"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=10
# DATABASE_URL is set to a placeholder here and replaced via sed in docker-entrypoint.sh
# All other environment variables (NODE_ENV, ARCHESTRA_*, etc.) are inherited automatically
environment=DATABASE_URL="placeholder"

[program:frontend]
directory=/app/frontend
command=/bin/sh -c "sleep 8 && node server.js"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=20
# HOSTNAME="0.0.0.0" is required for Next.js standalone server to bind to all interfaces.
# Without this, Next.js binds only to the container's IP, breaking kubectl port-forward.
# See: https://nextjs.org/docs/app/api-reference/config/next-config-js/output#automatically-copying-traced-files
# NEXT_PUBLIC_* variables are mapped from ARCHESTRA_* ENV variables
# All other environment variables (NODE_ENV, etc.) are inherited automatically
environment=HOSTNAME="0.0.0.0",NEXT_PUBLIC_ARCHESTRA_API_BASE_URL="%(ENV_ARCHESTRA_API_BASE_URL)s",NEXT_PUBLIC_ARCHESTRA_ANALYTICS="%(ENV_ARCHESTRA_ANALYTICS)s",NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN="%(ENV_ARCHESTRA_SENTRY_FRONTEND_DSN)s",NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT="%(ENV_ARCHESTRA_SENTRY_ENVIRONMENT)s",NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED="%(ENV_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED)s",NEXT_PUBLIC_ARCHESTRA_AUTH_DISABLE_BASIC_AUTH="%(ENV_ARCHESTRA_AUTH_DISABLE_BASIC_AUTH)s",NEXT_PUBLIC_ARCHESTRA_AUTH_DISABLE_INVITATIONS="%(ENV_ARCHESTRA_AUTH_DISABLE_INVITATIONS)s"
EOF

# Create postgres program configuration (to be conditionally included)
RUN cat > /etc/supervisord.postgres.conf <<'EOF'

[program:postgres]
user=postgres
command=postgres -D /var/lib/postgresql/data
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=1
EOF

# Create initialization script
RUN cat > /docker-entrypoint.sh <<'EOF'
#!/bin/sh
set -e

# Track if we created a KinD cluster for cleanup
KIND_CLUSTER=""
# Track supervisord PID for cleanup
SUPERVISOR_PID=""

# Cleanup function for graceful shutdown
# Usage: cleanup [exit_code]
# If exit_code not provided, defaults to 0 (signal-triggered cleanup)
cleanup() {
    CLEANUP_EXIT_CODE="${1:-0}"

    echo "Shutting down..."

    # Stop supervisord gracefully before cleaning up KinD cluster
    if [ -n "$SUPERVISOR_PID" ] && kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
        echo "Stopping services..."
        kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
        wait "$SUPERVISOR_PID" 2>/dev/null || true
    fi

    # Delete KinD cluster if we created one in quickstart mode
    if [ -n "$KIND_CLUSTER" ]; then
        echo "Deleting KinD cluster '${KIND_CLUSTER}'..."
        if kind delete cluster --name "${KIND_CLUSTER}" 2>/dev/null; then
            echo "KinD cluster deleted successfully"
        else
            echo "Warning: Failed to delete KinD cluster"
        fi
    fi

    exit "$CLEANUP_EXIT_CODE"
}

# Generate and persist ARCHESTRA_AUTH_SECRET if not set
if [ -z "$ARCHESTRA_AUTH_SECRET" ]; then
    SECRET_FILE="/app/data/.auth_secret"

    if [ -f "$SECRET_FILE" ]; then
        # Load existing secret
        export ARCHESTRA_AUTH_SECRET=$(cat "$SECRET_FILE")
        echo "Loaded existing ARCHESTRA_AUTH_SECRET from $SECRET_FILE"
    else
        # Generate new random secret (64 characters)
        export ARCHESTRA_AUTH_SECRET=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 64 | head -n 1)

        # Persist it
        mkdir -p /app/data
        echo "$ARCHESTRA_AUTH_SECRET" > "$SECRET_FILE"
        chmod 600 "$SECRET_FILE"
        echo "Generated and saved new ARCHESTRA_AUTH_SECRET to $SECRET_FILE"
    fi
fi

# Quickstart mode: enable if ARCHESTRA_QUICKSTART is set
# WARNING: Docker socket mounting provides container with privileged access to the host.
# This is intended for local development ONLY. Never use in production environments.
# For production, use external Kubernetes clusters without mounting the Docker socket.
if [ "$ARCHESTRA_QUICKSTART" = "true" ]; then
    echo "ARCHESTRA_QUICKSTART=true detected"
    echo "Quickstart mode enabled - initializing embedded KinD cluster..."

    if [ ! -S /var/run/docker.sock ]; then
        echo "Quickstart mode is on but Docker socket is not mounted"
        echo "Add: -v /var/run/docker.sock:/var/run/docker.sock to your docker run command"
        exit 1
    fi
    echo "WARNING: Docker socket mounted - this mode is for development only, not for production use."

    if ! command -v kind >/dev/null 2>&1; then
        echo "ERROR: KinD binary not found in this image."
        exit 1
    fi

    # Quickstart mode always uses embedded KinD cluster
    CLUSTER_NAME="archestra-mcp"
    KUBECONFIG_PATH="/app/data/.kubeconfig"
    # Pin a known-good node image to avoid compatibility issues with newer K8s versions.
    # Must match a version supported by the KinD binary version compiled in the builder stage.
    # See: https://github.com/kubernetes-sigs/kind/releases/tag/v0.31.0
    KIND_NODE_IMAGE="kindest/node:v1.34.3@sha256:08497ee19eace7b4b5348db5c6a1591d7752b164530a36f855cb0f2bdcbadd48"

    # Check if cluster already exists
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        echo "KinD cluster '${CLUSTER_NAME}' already exists"
    else
        echo "Creating KinD cluster '${CLUSTER_NAME}'..."
        if ! kind create cluster --name "${CLUSTER_NAME}" --image "${KIND_NODE_IMAGE}" --wait 120s; then
            echo ""
            echo "=== KinD cluster creation failed ==="
            echo ""

            # Detect Docker environment
            DOCKER_SERVER_OS=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || echo "unknown")
            DOCKER_SERVER_PLATFORM=$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null || echo "unknown")
            DOCKER_MEMORY_BYTES=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo "0")
            DOCKER_MEMORY_GB=$(awk "BEGIN {printf \"%.1f\", ${DOCKER_MEMORY_BYTES:-0} / 1073741824}")

            echo "Docker environment:"
            echo "  Server OS: ${DOCKER_SERVER_OS}"
            echo "  Platform:  ${DOCKER_SERVER_PLATFORM}"
            echo "  Memory:    ${DOCKER_MEMORY_GB} GB"
            echo ""

            IS_DOCKER_DESKTOP=false
            if echo "${DOCKER_SERVER_OS}" | grep -qi "docker desktop"; then
                IS_DOCKER_DESKTOP=true
            fi

            echo "Troubleshooting steps:"
            if [ "${IS_DOCKER_DESKTOP}" = "true" ]; then
                echo "  1. Increase Docker Desktop memory to at least 4 GB"
                echo "     (Settings > Resources > Memory)"
                if echo "${DOCKER_SERVER_PLATFORM}" | grep -qi "amd64"; then
                    echo "  2. Ensure Docker Desktop is using the WSL 2 backend"
                    echo "     (Settings > General > Use the WSL 2 based engine)"
                fi
                echo "  3. Restart Docker Desktop and try again"
                echo "  4. Ensure Docker has sufficient disk space"
                echo "     Run: docker system prune -f"
            else
                echo "  1. Ensure Docker has at least 4 GB of memory available"
                echo "  2. Ensure Docker has sufficient disk space"
                echo "     Run: docker system prune -f"
                echo "  3. Restart Docker and try again"
            fi
            echo ""
            echo "NOTE: You do NOT need to enable Kubernetes in Docker Desktop settings."
            echo "      Archestra uses KinD (Kubernetes in Docker) which manages its own cluster."
            echo ""
            echo "For help: https://github.com/archestra-ai/archestra/issues"

            exit 1
        fi
        echo "KinD cluster created successfully"
        # Mark for cleanup on shutdown
        KIND_CLUSTER="${CLUSTER_NAME}"
    fi

    # Export kubeconfig
    if ! kind export kubeconfig --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG_PATH}"; then
        echo "ERROR: Failed to export kubeconfig for KinD cluster"
        exit 1
    fi
    chmod 600 "${KUBECONFIG_PATH}"

    # Get the KinD control plane container IP address
    CONTROL_PLANE_CONTAINER="${CLUSTER_NAME}-control-plane"
    CONTROL_PLANE_IP=$(docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}' "${CONTROL_PLANE_CONTAINER}")

    if [ -z "$CONTROL_PLANE_IP" ]; then
        echo "ERROR: Could not get KinD control plane IP address"
        exit 1
    else
        echo "KinD control plane IP: ${CONTROL_PLANE_IP}"

        # Update kubeconfig to use control plane IP and skip TLS verification
        # TLS verification is disabled here because:
        # 1. This is ONLY for local development with embedded KinD cluster
        # 2. Traffic never leaves the host machine (container-to-container communication)
        # 3. The certificate is for localhost/127.0.0.1, not the container IP we're using
        # 4. Production deployments use external K8s clusters with proper TLS certificates
        # Use targeted approach to avoid duplicates and only modify KinD cluster entries
        cat "${KUBECONFIG_PATH}" | \
            sed "s|server: https://127.0.0.1:[0-9][0-9]*|server: https://${CONTROL_PLANE_IP}:6443|g" | \
            awk '
                /^    server: https:\/\/.*:6443$/ {
                    print
                    if (!insecure_added) {
                        print "    insecure-skip-tls-verify: true"
                        insecure_added = 1
                    }
                    next
                }
                /^    insecure-skip-tls-verify:/ { next }
                { print }
            ' > "${KUBECONFIG_PATH}.tmp"
        mv "${KUBECONFIG_PATH}.tmp" "${KUBECONFIG_PATH}"
        chmod 600 "${KUBECONFIG_PATH}"

        # Connect this container to the KinD network for direct communication
        # SECURITY WARNING: This grants the container privileged access to manipulate
        # host Docker networks. This is acceptable ONLY for local development.
        CONTAINER_ID=$(hostname)
        if ! docker network inspect kind >/dev/null 2>&1; then
            echo "WARNING: KinD network not found"
        else
            # Check if already connected to kind network
            if docker inspect "$CONTAINER_ID" -f '{{range $net, $v := .NetworkSettings.Networks}}{{$net}} {{end}}' 2>/dev/null | grep -q "kind"; then
                echo "Container already connected to KinD network"
            else
                echo "Connecting container to KinD network..."
                if ! docker network connect kind "$CONTAINER_ID"; then
                    echo "ERROR: Failed to connect container to KinD network"
                    exit 1
                fi
                echo "Connected to KinD network successfully"
            fi
        fi

        # Export the kubeconfig path for supervisord to inherit, only if setup succeeded
        export ARCHESTRA_ORCHESTRATOR_KUBECONFIG="${KUBECONFIG_PATH}"
        export ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE="${ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE:-default}"
        export ARCHESTRA_ORCHESTRATOR_K8S_NODE_HOST="${CONTROL_PLANE_IP}"
        echo "Kubernetes orchestrator configured with embedded KinD cluster"
    fi
fi

# Check if using external database (ARCHESTRA_DATABASE_URL or DATABASE_URL is set)
USE_EXTERNAL_DB=false
if [ -n "$ARCHESTRA_DATABASE_URL" ] || [ -n "$DATABASE_URL" ]; then
    USE_EXTERNAL_DB=true
fi

# Parse DATABASE_URL (prefer ARCHESTRA_DATABASE_URL, fallback to DATABASE_URL)
EFFECTIVE_DATABASE_URL="${ARCHESTRA_DATABASE_URL:-$DATABASE_URL}"

if [ "$USE_EXTERNAL_DB" = "false" ]; then
    echo "Using internal PostgreSQL database"

    # Use defaults for internal database
    POSTGRES_USER=${POSTGRES_USER:-archestra}
    POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-archestra_dev_password}
    POSTGRES_DB=${POSTGRES_DB:-archestra_dev}
    EFFECTIVE_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}?schema=public"

    # Append postgres program to supervisord config
    cat /etc/supervisord.postgres.conf >> /etc/supervisord.conf

    # Initialize PostgreSQL if data directory is empty
    if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then
        echo "Initializing PostgreSQL database..."
        su-exec postgres initdb -D /var/lib/postgresql/data

        # Configure PostgreSQL
        echo "host all all all md5" >> /var/lib/postgresql/data/pg_hba.conf
        echo "listen_addresses='*'" >> /var/lib/postgresql/data/postgresql.conf

        # Start PostgreSQL temporarily to create user and database
        su-exec postgres pg_ctl -D /var/lib/postgresql/data -o "-c listen_addresses=''" -w start

        # Create user and database
        psql -v ON_ERROR_STOP=1 --username postgres <<-EOSQL
            CREATE USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';
            CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};
            GRANT ALL PRIVILEGES ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_USER};
EOSQL

        # Stop PostgreSQL
        su-exec postgres pg_ctl -D /var/lib/postgresql/data -m fast -w stop

        echo "PostgreSQL initialized successfully"
    fi
else
    echo "Using external PostgreSQL database"
    # Note: POSTGRES_USER/PASSWORD/DB extraction removed - not needed for external databases
    # The application uses EFFECTIVE_DATABASE_URL directly
fi

# Update supervisord config with actual environment variables
# Escape % as %% for supervisord (it uses % for string interpolation like %(ENV_VAR)s)
# Then use awk to handle other special characters in DATABASE_URL (like |, &, \)
ESCAPED_DATABASE_URL=$(echo "$EFFECTIVE_DATABASE_URL" | sed 's/%/%%/g')
awk -v url="$ESCAPED_DATABASE_URL" '{gsub(/DATABASE_URL="[^"]*"/, "DATABASE_URL=\"" url "\""); print}' /etc/supervisord.conf > /etc/supervisord.conf.tmp && mv /etc/supervisord.conf.tmp /etc/supervisord.conf

# Propagate analytics setting to frontend (enabled by default, set to "disabled" to opt-out)
if [ -n "$ARCHESTRA_ANALYTICS" ]; then
  sed -i "s|environment=\(.*\)|environment=\1,NEXT_PUBLIC_ARCHESTRA_ANALYTICS=\"${ARCHESTRA_ANALYTICS}\"|g" /etc/supervisord.conf
fi

# Configure ngrok tunnel if auth token is provided
# ngrok is downloaded at runtime (not baked into the image) to avoid shipping
# its Go stdlib CVEs in the Docker image. It's only needed when tunneling is enabled.
# Pin to specific version with SHA256 verification for reproducibility and security.
if [ -n "$ARCHESTRA_NGROK_AUTH_TOKEN" ]; then
    echo "ngrok auth token detected - downloading ngrok and enabling tunnel to port 3000"
    NGROK_VERSION="3.36.1"
    ARCH=$(uname -m)
    if [ "$ARCH" = "x86_64" ]; then
        NGROK_ARCH="amd64"
        NGROK_SHA256="4fe9d21be38fe8d4360b692543a2cc7345fc291b54a82ea99e7d33e46cadb765"
    elif [ "$ARCH" = "aarch64" ]; then
        NGROK_ARCH="arm64"
        NGROK_SHA256="d04cc4650896e4f324e624247669f7b0d45ba28a19535fc3615d11c7b726a97e"
    else
        echo "ERROR: Unsupported architecture for ngrok: $ARCH"
        exit 1
    fi
    NGROK_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v${NGROK_VERSION}-linux-${NGROK_ARCH}.tgz"
    if ! wget -qO /tmp/ngrok.tgz "${NGROK_URL}"; then
        echo "ERROR: Failed to download ngrok from ${NGROK_URL}"
        exit 1
    fi
    echo "${NGROK_SHA256}  /tmp/ngrok.tgz" | sha256sum -c - || { echo "ERROR: ngrok checksum mismatch"; rm -f /tmp/ngrok.tgz; exit 1; }
    tar -xzf /tmp/ngrok.tgz -C /usr/local/bin && \
        chmod +x /usr/local/bin/ngrok && \
        rm -f /tmp/ngrok.tgz
    echo "ngrok $(ngrok version) installed"
    ngrok config add-authtoken "$ARCHESTRA_NGROK_AUTH_TOKEN"

    # Build ngrok command with optional static domain
    if [ -n "$ARCHESTRA_NGROK_DOMAIN" ]; then
        NGROK_CMD="ngrok http 3000 --log=stdout --log-format=term --domain=${ARCHESTRA_NGROK_DOMAIN}"
        echo "Using custom ngrok domain: ${ARCHESTRA_NGROK_DOMAIN}"
    else
        NGROK_CMD="ngrok http 3000 --log=stdout --log-format=term"
    fi

    # Append ngrok program to supervisord config
    cat >> /etc/supervisord.conf <<NGROK_CONF

[program:ngrok]
command=/bin/sh -c "sleep 10 && ${NGROK_CMD}"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=25
NGROK_CONF

    # If no explicit domain, detect the dynamically assigned ngrok domain
    # after ngrok starts. Write it to a file so the backend can read it.
    if [ -z "$ARCHESTRA_NGROK_DOMAIN" ]; then
        cat > /app/detect-ngrok-domain.sh <<'DETECT_SCRIPT'
#!/bin/sh
# Poll ngrok API to discover the dynamically assigned tunnel URL
for i in $(seq 1 30); do
    NGROK_RESPONSE=$(wget -qO- http://localhost:4040/api/tunnels 2>/dev/null || true)
    if [ -n "$NGROK_RESPONSE" ]; then
        TUNNEL_URL=$(echo "$NGROK_RESPONSE" | sed -n 's/.*"public_url":"\([^"]*\)".*/\1/p' | head -1)
        if [ -n "$TUNNEL_URL" ]; then
            # Extract domain from URL (remove https:// prefix)
            NGROK_DOMAIN=$(echo "$TUNNEL_URL" | sed 's|https://||')
            echo "Detected ngrok domain: ${NGROK_DOMAIN}"
            echo "$NGROK_DOMAIN" > /app/data/.ngrok_domain
            exit 0
        fi
    fi
    sleep 1
done
echo "Warning: Could not detect ngrok domain after 30 seconds"
DETECT_SCRIPT
        chmod +x /app/detect-ngrok-domain.sh

        cat >> /etc/supervisord.conf <<DETECT_CONF

[program:detect-ngrok-domain]
command=/bin/sh -c "sleep 15 && /app/detect-ngrok-domain.sh"
autostart=true
autorestart=false
startsecs=0
priority=26
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
DETECT_CONF
    fi
fi

# Add startup banner to supervisord (sleeps 12s to ensure it prints after Next.js logs)
cat >> /etc/supervisord.conf <<CONF

[program:startup-banner]
command=/bin/sh -c "sleep 12 && /app/docker-banner.sh"
autostart=true
autorestart=false
startsecs=0
priority=999
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
CONF

# Set up signal handlers now that all initialization is complete
trap cleanup SIGTERM SIGINT

# Start supervisord in foreground but allow signal handling
# Run in background and wait so trap can catch signals
/usr/bin/supervisord -c /etc/supervisord.conf &
SUPERVISOR_PID=$!

# Wait for supervisord to exit (or for a signal)
wait "$SUPERVISOR_PID"
# Note: if supervisord is terminated by a signal, `wait` returns 128 + signal.
# We intentionally propagate this composite exit code to `cleanup` for diagnostics.
EXIT_CODE=$?

# If we get here, supervisord exited on its own or was terminated by a signal.
# Run cleanup with the raw exit code from `wait` (may be 128 + signal on signals).
cleanup "$EXIT_CODE"
EOF

RUN chmod +x /docker-entrypoint.sh
RUN chmod +x /app/docker-banner.sh

# Expose ports
EXPOSE 5432 9000 9050 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
