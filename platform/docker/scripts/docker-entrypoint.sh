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

    # Bundle the Dagger Engine that backs the skill sandbox / code runtime
    # (archestra__run_command and friends). It runs as a privileged pod in the embedded KinD
    # cluster; the backend reaches it over kube-pod:// (kubectl exec + buildctl
    # dial-stdio), so no Service or TCP port is needed. The manifest is the
    # helm/dagger-runtime chart rendered with laptop-sized resources.
    # Opt out with ARCHESTRA_CODE_RUNTIME_ENABLED=false.
    if [ "${ARCHESTRA_CODE_RUNTIME_ENABLED:-true}" = "true" ]; then
        echo "Deploying embedded Dagger Engine for code runtime..."
        echo "NOTE: the engine is privileged and memory-hungry; ensure Docker has at least 6 GB."

        # Pre-load the engine image straight into the node's containerd. KinD is
        # recreated each run and its containerd cannot see the host Docker image
        # cache, so without this every boot would pull ~352MB from the registry.
        # The image is baked into this image as a docker-archive at build time, so
        # the engine starts offline (manifest uses imagePullPolicy: IfNotPresent).
        echo "Loading bundled Dagger Engine image into KinD (offline, no registry pull)..."
        kind load image-archive /app/dagger-engine.tar --name "${CLUSTER_NAME}" \
            || echo "WARNING: kind load failed; the engine will fall back to a registry pull"

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
            export ARCHESTRA_CODE_RUNTIME_ENABLED="true"
            export ARCHESTRA_AGENTS_SKILLS_ENABLED="${ARCHESTRA_AGENTS_SKILLS_ENABLED:-true}"
            export ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST="kube-pod://dagger-runtime-engine-0?namespace=default&container=dagger-engine"
            echo "Dagger Engine ready - code runtime enabled"
        else
            echo "WARNING: Dagger Engine did not become ready; code runtime stays disabled"
        fi
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

        # Create pgvector extension as superuser (required for knowledge base feature)
        psql -v ON_ERROR_STOP=1 --username postgres --dbname ${POSTGRES_DB} <<-EOSQL
            CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

        # Stop PostgreSQL
        su-exec postgres pg_ctl -D /var/lib/postgresql/data -m fast -w stop

        echo "PostgreSQL initialized successfully"
    else
        # Existing database — ensure pgvector extension exists (idempotent).
        # On first init the extension is created above, but upgrades from older
        # images need it created retroactively before Drizzle migrations run.
        su-exec postgres pg_ctl -D /var/lib/postgresql/data -o "-c listen_addresses=''" -w start
        psql -v ON_ERROR_STOP=1 --username postgres --dbname ${POSTGRES_DB} <<-EOSQL
            CREATE EXTENSION IF NOT EXISTS vector;
EOSQL
        su-exec postgres pg_ctl -D /var/lib/postgresql/data -m fast -w stop
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
