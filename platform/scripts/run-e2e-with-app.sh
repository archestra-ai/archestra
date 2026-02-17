#!/usr/bin/env bash
# Two-phase E2E: start BACKEND first and wait for it, then start FRONTEND, then run Playwright.
# This avoids frontend hitting ECONNREFUSED while backend is still starting.
# Run from platform root: ./scripts/run-e2e-with-app.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$PLATFORM_ROOT/frontend"
OVERRIDE_PATH="$FRONTEND_DIR/.env.development.local"
OVERRIDE_BACKUP="$FRONTEND_DIR/.env.development.local.e2e-backup"
OVERRIDE_WRITTEN=false
BACKEND_PID=""
FRONTEND_PID=""
VAULT_STARTED=false
VAULT_COMPOSE=""

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[1;33m'
cyan='\033[0;36m'
nc='\033[0m'
[ ! -t 1 ] && red= green= yellow= cyan= nc=

stop_process_on_port() {
    local port="$1"
    local pid
    if command -v lsof >/dev/null 2>&1; then
        pid=$(lsof -ti ":$port" 2>/dev/null || true)
        if [ -n "$pid" ]; then
            echo -e "${yellow}Stopping process on port $port (PID $pid) ...${nc}"
            kill -9 $pid 2>/dev/null || true
            sleep 2
        fi
    elif command -v fuser >/dev/null 2>&1; then
        if fuser "$port/tcp" >/dev/null 2>&1; then
            echo -e "${yellow}Stopping process on port $port ...${nc}"
            fuser -k "$port/tcp" 2>/dev/null || true
            sleep 2
        fi
    else
        echo -e "${yellow}Could not free port $port: lsof/fuser not found${nc}"
    fi
}

wait_for_url() {
    local url="$1"
    local max_attempts="${2:-60}"
    local delay_sec="${3:-2}"
    local i=0
    while [ $i -lt "$max_attempts" ]; do
        if curl -s -o /dev/null --connect-timeout 5 "$url" 2>/dev/null; then
            return 0
        fi
        if [ $i -eq 0 ]; then echo -e "${yellow}Waiting for $url ...${nc}"; fi
        sleep "$delay_sec"
        i=$((i + 1))
    done
    return 1
}

cleanup() {
    stop_process_on_port 3000
    stop_process_on_port 9000
    if [ "$VAULT_STARTED" = true ] && command -v docker >/dev/null 2>&1; then
        (cd "$PLATFORM_ROOT" && docker compose -f "$VAULT_COMPOSE" down 2>/dev/null) || true
    fi
    sleep 2
    for pid in $BACKEND_PID $FRONTEND_PID; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 2
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
    stop_process_on_port 3000
    stop_process_on_port 9000
    if [ "$OVERRIDE_WRITTEN" = true ]; then
        rm -f "$OVERRIDE_PATH"
        [ -f "$OVERRIDE_BACKUP" ] && mv "$OVERRIDE_BACKUP" "$OVERRIDE_PATH"
    fi
    if [ "$BACKEND_ENV_CREATED" = true ] && [ -f "$PLATFORM_ROOT/backend/.env" ]; then
        rm -f "$PLATFORM_ROOT/backend/.env"
    fi
}

trap cleanup EXIT

echo -e "${cyan}=== Freeing ports 3000 and 9000 ===${nc}"
stop_process_on_port 3000
stop_process_on_port 9000
sleep 3
stop_process_on_port 3000
stop_process_on_port 9000
sleep 2

for port in 3000 9000; do
    if command -v lsof >/dev/null 2>&1; then
        pid=$(lsof -ti ":$port" 2>/dev/null || true)
    else
        pid=""
        command -v fuser >/dev/null 2>&1 && fuser "$port/tcp" >/dev/null 2>&1 && pid="in use"
    fi
    if [ -n "$pid" ]; then
        echo -e "${red}Port $port still in use. Stop any other dev server and retry.${nc}"
        exit 1
    fi
done

# Load platform .env and ensure backend has it
if [ -f "$PLATFORM_ROOT/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$PLATFORM_ROOT/.env"
    set +a
    BACKEND_ENV_EXISTED=false
    [ -f "$PLATFORM_ROOT/backend/.env" ] && BACKEND_ENV_EXISTED=true
    cp "$PLATFORM_ROOT/.env" "$PLATFORM_ROOT/backend/.env"
    [ "$BACKEND_ENV_EXISTED" = false ] && BACKEND_ENV_CREATED=true || BACKEND_ENV_CREATED=false
else
    BACKEND_ENV_CREATED=false
fi

export ARCHESTRA_API_BASE_URL="http://127.0.0.1:9000"
export NEXT_PUBLIC_ARCHESTRA_API_BASE_URL="http://127.0.0.1:9000"
[ -f "$OVERRIDE_PATH" ] && mv "$OVERRIDE_PATH" "$OVERRIDE_BACKUP"
printf '%s\n' \
    "ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000" \
    "NEXT_PUBLIC_ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000" \
    > "$OVERRIDE_PATH"
OVERRIDE_WRITTEN=true

# Optionally start Vault for credentials-with-vault E2E (continues without Vault if Docker unavailable)
VAULT_COMPOSE="$PLATFORM_ROOT/dev/docker-compose.vault.ee.yml"
if command -v docker >/dev/null 2>&1; then
    echo -e "${cyan}=== Starting Vault (Docker) for E2E ===${nc}"
    if (cd "$PLATFORM_ROOT" && docker compose -f "$VAULT_COMPOSE" up -d 2>/dev/null); then
        VAULT_STARTED=true
        echo -e "${yellow}Waiting for Vault at http://127.0.0.1:8200 ...${nc}"
        sleep 8
        i=0
        while [ $i -lt 30 ]; do
            if curl -s -o /dev/null --connect-timeout 3 "http://127.0.0.1:8200/v1/sys/health" 2>/dev/null; then
                echo -e "${green}Vault ready.${nc}"
                break
            fi
            sleep 2
            i=$((i + 1))
        done
        if [ $i -ge 30 ]; then
            echo -e "${yellow}Vault did not become ready; credentials-with-vault tests will be skipped.${nc}"
        fi
    else
        echo -e "${yellow}Vault failed to start; credentials-with-vault tests will be skipped.${nc}"
    fi
else
    echo -e "${yellow}Docker not found; credentials-with-vault tests will be skipped. (Start Vault at localhost:8200 to run them.)${nc}"
fi

# --- Phase 1: start BACKEND only ---
echo -e "\n${cyan}=== Phase 1: Starting BACKEND only ===${nc}"
cd "$PLATFORM_ROOT"
pnpm --filter @backend dev &
BACKEND_PID=$!

echo -e "${yellow}Backend building and starting (polling after 90s) ...${nc}"
sleep 90
if ! wait_for_url "http://127.0.0.1:9000/health" 300 2; then
    echo -e "${red}Backend (9000) did not become ready. Check Postgres, migrations (pnpm db:migrate), and backend logs.${nc}"
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
fi
health_body=$(curl -s --connect-timeout 5 "http://127.0.0.1:9000/health" 2>/dev/null || true)
if echo "$health_body" | grep -q "<Error>"; then
    echo -e "${red}Backend (9000) returned wrong response. Ensure nothing else is on 9000.${nc}"
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
fi
echo -e "${green}Backend ready.${nc}"

# --- Phase 2: start FRONTEND only ---
echo -e "\n${cyan}=== Phase 2: Starting FRONTEND only ===${nc}"
pnpm --filter @frontend dev &
FRONTEND_PID=$!

if ! wait_for_url "http://localhost:3000" 60 2; then
    echo -e "${red}Frontend (3000) did not become ready.${nc}"
    kill "$FRONTEND_PID" 2>/dev/null || true
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
fi
echo -e "${green}Frontend ready.${nc}"
sleep 3

echo -e "\n${cyan}=== Running E2E tests ===${nc}"
e2e_exit=0
(cd "$PLATFORM_ROOT/e2e-tests" && pnpm exec playwright test --project=setup-admin --project=setup-users --project=setup-teams --project=chromium-stable) || e2e_exit=$?
exit $e2e_exit
