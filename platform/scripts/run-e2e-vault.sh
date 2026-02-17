#!/usr/bin/env bash
# Run E2E with Vault: start Vault (Docker), app, then credentials-with-vault tests only.
# Requires Docker running. From platform root: ./scripts/run-e2e-vault.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VAULT_COMPOSE="$PLATFORM_ROOT/dev/docker-compose.vault.ee.yml"
FRONTEND_DIR="$PLATFORM_ROOT/frontend"
OVERRIDE_PATH="$FRONTEND_DIR/.env.development.local"
OVERRIDE_BACKUP="$FRONTEND_DIR/.env.development.local.e2e-backup"
BACKEND_PID=""
FRONTEND_PID=""

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[1;33m'
cyan='\033[0;36m'
nc='\033[0m'
[ ! -t 1 ] && red= green= yellow= cyan= nc=

stop_port() {
    local port="$1"
    local pid
    if command -v lsof >/dev/null 2>&1; then
        pid=$(lsof -ti ":$port" 2>/dev/null || true)
        [ -n "$pid" ] && kill -9 $pid 2>/dev/null || true
    fi
    sleep 2
}

wait_url() {
    local url="$1" max="${2:-60}" delay="${3:-2}" i=0
    while [ $i -lt "$max" ]; do
        curl -s -o /dev/null --connect-timeout 5 "$url" 2>/dev/null && return 0
        [ $i -eq 0 ] && echo -e "${yellow}Waiting for $url ...${nc}"
        sleep "$delay"
        i=$((i + 1))
    done
    return 1
}

cleanup() {
    stop_port 3000
    stop_port 9000
    [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
    command -v docker >/dev/null 2>&1 && (cd "$PLATFORM_ROOT" && docker compose -f "$VAULT_COMPOSE" down 2>/dev/null) || true
    [ -f "$OVERRIDE_PATH" ] && rm -f "$OVERRIDE_PATH"
    [ -f "$OVERRIDE_BACKUP" ] && mv "$OVERRIDE_BACKUP" "$OVERRIDE_PATH"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo -e "${red}Docker not found. Install Docker and add it to PATH.${nc}"; exit 1; }
docker info >/dev/null 2>&1 || { echo -e "${red}Docker daemon is not running. Start Docker Desktop (or the daemon) and re-run.${nc}"; exit 1; }

echo -e "${cyan}=== Freeing ports 3000, 9000, 8200 ===${nc}"
stop_port 3000
stop_port 9000
stop_port 8200
sleep 2

[ -f "$VAULT_COMPOSE" ] || { echo -e "${red}Compose file not found: $VAULT_COMPOSE${nc}"; exit 1; }

echo -e "${cyan}=== Starting Vault (Docker) ===${nc}"
(cd "$PLATFORM_ROOT" && docker compose -f "$VAULT_COMPOSE" up -d) || {
    echo -e "${red}Docker Compose failed. Ensure Docker is running and port 8200 is free, then re-run.${nc}"
    exit 1
}
echo -e "${yellow}Waiting for Vault at http://127.0.0.1:8200 ...${nc}"
sleep 5
i=0
while [ $i -lt 40 ]; do
    curl -s -o /dev/null --connect-timeout 5 "http://127.0.0.1:8200/v1/sys/health" 2>/dev/null && break
    sleep 2
    i=$((i + 1))
done
[ $i -ge 40 ] && { echo -e "${red}Vault did not become ready. Check: docker compose -f $VAULT_COMPOSE logs${nc}"; exit 1; }
echo -e "${green}Vault ready.${nc}"

curl -s -X PUT -H "X-Vault-Token: dev-root-token" -H "Content-Type: application/json" \
  -d '{"type":"kv","options":{"version":2}}' "http://127.0.0.1:8200/v1/sys/mounts/secret" >/dev/null 2>&1 || true
echo -e "${green}Vault: KV v2 at secret enabled.${nc}"

# Env and frontend override
[ -f "$PLATFORM_ROOT/.env" ] && set -a && . "$PLATFORM_ROOT/.env" && set +a
cp "$PLATFORM_ROOT/.env" "$PLATFORM_ROOT/backend/.env" 2>/dev/null || true
export ARCHESTRA_API_BASE_URL="http://127.0.0.1:9000"
export NEXT_PUBLIC_ARCHESTRA_API_BASE_URL="http://127.0.0.1:9000"
[ -f "$OVERRIDE_PATH" ] && mv "$OVERRIDE_PATH" "$OVERRIDE_BACKUP"
printf '%s\n' "ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000" "NEXT_PUBLIC_ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000" > "$OVERRIDE_PATH"

echo -e "\n${cyan}=== Starting BACKEND ===${nc}"
cd "$PLATFORM_ROOT" && pnpm --filter @backend dev &
BACKEND_PID=$!
echo -e "${yellow}Waiting for backend (90s then poll) ...${nc}"
sleep 90
wait_url "http://127.0.0.1:9000/health" 300 2 || { echo -e "${red}Backend not ready.${nc}"; exit 1; }
echo -e "${green}Backend ready.${nc}"

echo -e "\n${cyan}=== Starting FRONTEND ===${nc}"
pnpm --filter @frontend dev &
FRONTEND_PID=$!
wait_url "http://localhost:3000" 60 2 || { echo -e "${red}Frontend not ready.${nc}"; exit 1; }
echo -e "${green}Frontend ready.${nc}"
sleep 3

echo -e "\n${cyan}=== Running Vault E2E tests ===${nc}"
e2e_exit=0
(cd "$PLATFORM_ROOT/e2e-tests" && pnpm exec playwright test --project=setup-admin --project=setup-users --project=setup-teams --project=credentials-with-vault) || e2e_exit=$?
exit $e2e_exit
