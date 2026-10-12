#!/bin/sh
set -e

# Runtime initialization for the unified platform image.
# This script:
# - bootstraps a persistent auth secret when one is not provided
# - optionally provisions and wires up an embedded KinD cluster for quickstart mode
# - initializes or upgrades the bundled PostgreSQL data directory when using the internal DB
# - injects the resolved DATABASE_URL and optional ngrok programs into supervisord config
# - starts supervisord in the background so container signals can trigger graceful cleanup
# - tears down the embedded KinD cluster on shutdown when this container created it

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

    # Quickstart is meant for humans tailing `docker logs`, so default the
    # backend log format to pretty. User-set values win.
    export ARCHESTRA_LOGGING_FORMAT="${ARCHESTRA_LOGGING_FORMAT:-pretty}"

    # Explain to the human reading docker logs why we're about to spin up
    # a Kubernetes cluster. The box and the body are sized to the live TTY
    # width so the banner doesn't wrap mid-bar on narrow windows.
    BANNER_COLS=$(stty size 2>/dev/null | awk '{print $2}')
    [ -z "$BANNER_COLS" ] && BANNER_COLS="${COLUMNS:-80}"
    case "$BANNER_COLS" in ''|*[!0-9]*) BANNER_COLS=80 ;; esac
    [ "$BANNER_COLS" -lt 40 ] && BANNER_COLS=40
    BANNER_BAR=$(printf '═%.0s' $(seq 1 "$BANNER_COLS"))
    # 2-space left indent + 2-space safety margin so wrapped lines never
    # bump the right edge of the bar.
    BANNER_WRAP=$((BANNER_COLS - 4))
    CYAN='\033[1;36m'
    NC='\033[0m'

    echo ""
    printf "${CYAN}%s${NC}\n" "$BANNER_BAR"
    echo ""
    echo "Archestra's MCP Orchestrator is also a Kubernetes operator." \
        | fold -s -w "$BANNER_WRAP" \
        | while IFS= read -r line; do
            printf "${CYAN}  %s${NC}\n" "$line"
        done
    echo ""
    echo "For demo purposes we're running a small Kubernetes (KinD) cluster to spin up your MCP servers." \
        | fold -s -w "$BANNER_WRAP" \
        | sed 's/^/  /'
    echo ""
    printf "${CYAN}%s${NC}\n" "$BANNER_BAR"
    echo ""

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

    # Put the cluster on an IPv4-only network of our own instead of KinD's
    # default `kind` network, which is dual-stack. This container joins that
    # network, and with an IPv6 address on it, Docker runtimes such as OrbStack
    # forward host `localhost` (::1) to our IPv4-only servers and the
    # connection is reset.
    KIND_NETWORK="archestra-kind"
    export KIND_EXPERIMENTAL_DOCKER_NETWORK="${KIND_NETWORK}"
    if ! docker network inspect "${KIND_NETWORK}" >/dev/null 2>&1; then
        docker network create --ipv6=false "${KIND_NETWORK}" >/dev/null
    fi

    CONTROL_PLANE_CONTAINER="${CLUSTER_NAME}-control-plane"

    # A cluster created by an older image sits on KinD's dual-stack `kind`
    # network. Joining it would bring the localhost reset back, so recreate it
    # on KIND_NETWORK. MCP servers are redeployed from the database; files in
    # the old cluster's volumes are lost.
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$" \
        && ! docker inspect -f '{{range $net, $v := .NetworkSettings.Networks}}{{println $net}}{{end}}' "${CONTROL_PLANE_CONTAINER}" 2>/dev/null | grep -qx "${KIND_NETWORK}"; then
        echo "KinD cluster '${CLUSTER_NAME}' is on the dual-stack 'kind' network; recreating it on '${KIND_NETWORK}'..."
        if ! kind delete cluster --name "${CLUSTER_NAME}" >/dev/null 2>&1; then
            echo "ERROR: Failed to delete the old KinD cluster. Remove it with: docker rm -f ${CONTROL_PLANE_CONTAINER}"
            exit 1
        fi
    fi

    # Check if cluster already exists
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        echo "KinD cluster '${CLUSTER_NAME}' already exists"
    else
        echo "Creating KinD cluster '${CLUSTER_NAME}'..."
        # Drop KinD's lines that do not apply inside this container: the
        # "Here be dragons" warning KIND_EXPERIMENTAL_DOCKER_NETWORK triggers
        # (the override is intentional, see above), host kubectl hints, and
        # sign-off tips. pipefail keeps a failed create visible to the `if`.
        if ! (
            set -o pipefail
            kind create cluster --name "${CLUSTER_NAME}" --image "${KIND_NODE_IMAGE}" --wait 120s 2>&1 \
                | grep -v \
                    -e "Overriding docker network due to KIND_EXPERIMENTAL_DOCKER_NETWORK" \
                    -e "Here be dragons" \
                    -e "You can now use your cluster with" \
                    -e "kubectl cluster-info --context" \
                    -e "Not sure what to do next" \
                    -e "Have a question, bug, or feature request" \
                    -e "Have a nice day" \
                    -e "Thanks for using kind" \
                    -e "^$"
        ); then
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
    CONTROL_PLANE_IP=$(docker inspect -f "{{with index .NetworkSettings.Networks \"${KIND_NETWORK}\"}}{{.IPAddress}}{{end}}" "${CONTROL_PLANE_CONTAINER}")

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
        # Use targeted approach to avoid duplicates and only modify KinD cluster entries.
        # certificate-authority-data is dropped alongside enabling insecure-skip-tls-verify:
        # strict clients (kubectl, and the Dagger kube-pod:// transport) reject a kubeconfig
        # that sets both, so keeping the CA would break the bundled Dagger Engine connection.
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
                /^    certificate-authority-data:/ { next }
                { print }
            ' > "${KUBECONFIG_PATH}.tmp"
        mv "${KUBECONFIG_PATH}.tmp" "${KUBECONFIG_PATH}"
        chmod 600 "${KUBECONFIG_PATH}"

        # Connect this container to the KinD network for direct communication
        # SECURITY WARNING: This grants the container privileged access to manipulate
        # host Docker networks. This is acceptable ONLY for local development.
        CONTAINER_ID=$(hostname)
        if docker inspect "$CONTAINER_ID" -f '{{range $net, $v := .NetworkSettings.Networks}}{{println $net}}{{end}}' 2>/dev/null | grep -qx "${KIND_NETWORK}"; then
            echo "Container already connected to KinD network"
        else
            echo "Connecting container to KinD network..."
            if ! docker network connect "${KIND_NETWORK}" "$CONTAINER_ID"; then
                echo "ERROR: Failed to connect container to KinD network"
                exit 1
            fi
            echo "Connected to KinD network successfully"
        fi

        # Export the kubeconfig path for supervisord to inherit, only if setup succeeded
        export ARCHESTRA_ORCHESTRATOR_KUBECONFIG="${KUBECONFIG_PATH}"
        export ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE="${ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE:-default}"
        export ARCHESTRA_ORCHESTRATOR_K8S_NODE_HOST="${CONTROL_PLANE_IP}"
        echo "Kubernetes orchestrator configured with embedded KinD cluster"
    fi

    # Bundle the Dagger Engine that backs the skill sandbox / code runtime
    # (archestra__run_command and friends). It runs as a privileged pod in the embedded KinD
    # cluster; the backend reaches it over kube-pod:// (kubectl exec + buildctl
    # dial-stdio), so no Service or TCP port is needed. Real deployments have the
    # backend provision engines in code; the quickstart runs this one instead, so a
    # demo container never waits on an engine coming up at first use. The manifest
    # is docker/dagger-engine.quickstart.yaml, sized for a laptop.
    # Opt out with ARCHESTRA_CODE_RUNTIME_ENABLED=false.
    if [ "${ARCHESTRA_CODE_RUNTIME_ENABLED:-true}" = "true" ]; then
        echo "Deploying embedded Dagger Engine for code runtime..."
        echo "NOTE: the engine is privileged and memory-hungry; ensure Docker has at least 6 GB."

        # Pre-load the engine image straight into the node's containerd. KinD is
        # recreated each run and its containerd cannot see the host Docker image
        # cache, so without this every boot would pull ~352MB from the registry.
        # The image is baked into this image as a docker-archive at build time, so
        # the engine starts offline (manifest uses imagePullPolicy: IfNotPresent).
        # Slim image variants (CI e2e shards, Dockerfile target unified-slim) omit
        # the archive; they fall back to a registry pull if the engine is needed.
        if [ -f /app/dagger-engine.tar ]; then
            echo "Loading bundled Dagger Engine image into KinD (offline, no registry pull)..."
            kind load image-archive /app/dagger-engine.tar --name "${CLUSTER_NAME}" \
                || echo "WARNING: kind load failed; the engine will fall back to a registry pull"
        else
            echo "No bundled Dagger Engine archive in this image (slim variant); the engine will be pulled from the registry"
        fi

        # Gate the runtime on the engine actually being Ready: kubectl apply only
        # proves the API accepted the manifest, not that the pod scheduled and
        # passed its probe. With the image pre-loaded, 60s is ample on the happy
        # path; on timeout we leave the feature off rather than advertise a pod
        # that never came up.
        if kubectl --kubeconfig "${KUBECONFIG_PATH}" apply -f /app/dagger-engine.quickstart.yaml \
            && kubectl --kubeconfig "${KUBECONFIG_PATH}" rollout status \
                statefulset/dagger-runtime-engine -n default --timeout=60s; then
            # the dagger CLI spawned by the backend uses KUBECONFIG to exec into
            # the engine pod for the kube-pod:// transport.
            export KUBECONFIG="${KUBECONFIG_PATH}"
            # Setting the Dagger runner host is what turns the code sandbox on;
            # the backend enables the sandbox when a Dagger host is present.
            export ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST="kube-pod://dagger-runtime-engine-0?namespace=default&container=dagger-engine"
            echo "Dagger Engine ready - code runtime enabled"
        else
            echo "WARNING: Dagger Engine did not become ready; code runtime stays disabled"
        fi
    fi

    # Agent Runtime runs each task as a Sandbox resource of the upstream Agent
    # Sandbox controller. Real deployments install it as a cluster
    # prerequisite; the quickstart installs the version pinned in the
    # Dockerfile. Agent Runtime turns on once the backend detects it; until
    # then, or on failure, the UI reports the controller as missing.
    # Installed in the background so it never delays startup.
    (
        echo "Installing Agent Sandbox controller for Agent Runtime..."
        if [ ! -f /app/agent-sandbox.quickstart.yaml ]; then
            echo "WARNING: Agent Sandbox controller manifest missing from this image; Agent Runtime runs will fail"
        elif kubectl --kubeconfig "${KUBECONFIG_PATH}" apply --server-side -f /app/agent-sandbox.quickstart.yaml >/dev/null \
            && kubectl --kubeconfig "${KUBECONFIG_PATH}" wait --for=condition=Established --timeout=60s \
                crd/sandboxes.agents.x-k8s.io \
                crd/sandboxtemplates.extensions.agents.x-k8s.io \
                crd/sandboxwarmpools.extensions.agents.x-k8s.io \
                crd/sandboxclaims.extensions.agents.x-k8s.io >/dev/null \
            && kubectl --kubeconfig "${KUBECONFIG_PATH}" create configmap agent-sandbox-config -n agent-sandbox-system \
                --from-literal=allowed-label-domains=sandbox.users.io,archestra.io \
                --dry-run=client -o yaml \
                | kubectl --kubeconfig "${KUBECONFIG_PATH}" apply -f - >/dev/null \
            && kubectl --kubeconfig "${KUBECONFIG_PATH}" rollout restart deployment/agent-sandbox-controller -n agent-sandbox-system >/dev/null \
            && kubectl --kubeconfig "${KUBECONFIG_PATH}" rollout status deployment/agent-sandbox-controller -n agent-sandbox-system --timeout=120s >/dev/null; then
            echo "Agent Sandbox controller ready - Agent Runtime enabled"
        else
            echo "WARNING: Agent Sandbox controller did not become ready; Agent Runtime runs will fail until it is installed"
        fi
    ) &
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

    # Append postgres program to supervisord config. /etc survives a container
    # restart, so append only once.
    grep -q '^\[program:postgres\]' /etc/supervisord.conf \
        || cat /etc/supervisord.postgres.conf >> /etc/supervisord.conf

    # The setup below prints several screens of initdb and server output on a
    # healthy start. Keep it out of `docker logs` unless a step fails, and send
    # the temporary server's own log to a file that is shown on failure.
    # Both root (this script) and postgres (the temporary server) append to the
    # log. It lives in a private directory rather than straight in /tmp: with
    # fs.protected_regular, root may not open a postgres-owned file in a sticky
    # directory.
    PG_SETUP_DIR=$(mktemp -d)
    PG_SETUP_LOG="$PG_SETUP_DIR/postgres-setup.log"
    : > "$PG_SETUP_LOG"
    chown -R postgres "$PG_SETUP_DIR"
    pg_setup() {
        if ! "$@" >> "$PG_SETUP_LOG" 2>&1; then
            echo "ERROR: PostgreSQL setup failed running: $*"
            cat "$PG_SETUP_LOG"
            exit 1
        fi
    }
    # Crash recovery fsyncs the whole data directory first, which can take
    # minutes on a slow disk; pg_ctl's 60s default would fail the start.
    PG_CTL_TIMEOUT=${PGCTLTIMEOUT:-600}
    pg_temp_start() {
        pg_setup su-exec postgres pg_ctl -D /var/lib/postgresql/data \
            -o "-c listen_addresses='' -c log_checkpoints=off" \
            -l "$PG_SETUP_LOG" -s -w -t "$PG_CTL_TIMEOUT" start
    }
    pg_temp_stop() {
        pg_setup su-exec postgres pg_ctl -D /var/lib/postgresql/data -m fast -s -w -t "$PG_CTL_TIMEOUT" stop
    }
    # CREATE EXTENSION IF NOT EXISTS reports "already exists" as a NOTICE.
    export PGOPTIONS="-c client_min_messages=warning"

    # Initialize PostgreSQL if data directory is empty
    if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then
        echo "Initializing PostgreSQL database..."
        pg_setup su-exec postgres initdb -D /var/lib/postgresql/data

        # Configure PostgreSQL
        echo "host all all all md5" >> /var/lib/postgresql/data/pg_hba.conf
        echo "listen_addresses='*'" >> /var/lib/postgresql/data/postgresql.conf

        # Start PostgreSQL temporarily to create user and database
        pg_temp_start

        # Create user and database
        pg_setup psql -q -v ON_ERROR_STOP=1 --username postgres <<-EOSQL
            CREATE USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';
            CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};
            GRANT ALL PRIVILEGES ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_USER};
EOSQL

        # Create pgvector extension as superuser (required for knowledge base feature)
        pg_setup psql -q -v ON_ERROR_STOP=1 --username postgres --dbname ${POSTGRES_DB} <<-EOSQL
            CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

        # Stop PostgreSQL
        pg_temp_stop

        echo "PostgreSQL initialized successfully"
    else
        # Existing database — ensure pgvector extension exists (idempotent).
        # On first init the extension is created above, but upgrades from older
        # images need it created retroactively before Drizzle migrations run.
        pg_temp_start
        pg_setup psql -q -v ON_ERROR_STOP=1 --username postgres --dbname ${POSTGRES_DB} <<-EOSQL
            CREATE EXTENSION IF NOT EXISTS vector;
EOSQL
        pg_temp_stop
    fi
    unset PGOPTIONS
    rm -rf "$PG_SETUP_DIR"
else
    echo "Using external PostgreSQL database"
    # Note: POSTGRES_USER/PASSWORD/DB extraction removed - not needed for external databases
    # The application uses EFFECTIVE_DATABASE_URL directly
fi

# Supervisord passes its own environment through unchanged. Exporting avoids
# rewriting a config file and preserves every legal URL character verbatim.
export DATABASE_URL="$EFFECTIVE_DATABASE_URL"

# Normalize the keep-alive timeout before either server reads it.
#
# The backend validates this itself and falls back to the default on a bad
# value, but supervisord hands the raw string to the Next.js server as
# KEEP_ALIVE_TIMEOUT, and that server treats anything unparsable as "unset" and
# drops to Node's 5s default. Without this, one typo would leave the two servers
# on wildly different windows — and silently put the *public-facing* one back on
# the 5s window this setting exists to move it off. Validating once here keeps
# both processes on the same number whatever the input was.
KEEP_ALIVE_DEFAULT_MS=620000
keep_alive_ms="$ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS"
keep_alive_invalid=""
case "$keep_alive_ms" in
    "") keep_alive_ms="$KEEP_ALIVE_DEFAULT_MS" ;;
    # Any non-digit rules it out: "-5", "1.5", "620_000", "620s", "abc".
    *[!0-9]*) keep_alive_invalid=1 ;;
    # All digits, so reject only zero (and anything the shell cannot compare,
    # e.g. a value too large for its integer arithmetic).
    *) [ "$keep_alive_ms" -gt 0 ] 2>/dev/null || keep_alive_invalid=1 ;;
esac
if [ -n "$keep_alive_invalid" ]; then
    echo "WARNING: invalid ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS value '$ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS', using default ${KEEP_ALIVE_DEFAULT_MS}ms" >&2
    keep_alive_ms="$KEEP_ALIVE_DEFAULT_MS"
fi
export ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS="$keep_alive_ms"
unset keep_alive_ms keep_alive_invalid

# ngrok tunneling (ARCHESTRA_NGROK_AUTH_TOKEN / ARCHESTRA_NGROK_DOMAIN) is now
# handled in-process by the backend via the ngrok agent SDK — no binary download
# or supervisord program is needed. See backend/src/ngrok-tunnel-manager.ts.

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
