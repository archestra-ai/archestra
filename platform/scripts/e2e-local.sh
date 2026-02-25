#!/usr/bin/env bash
#
# Run E2E tests locally in an isolated Kind cluster — same as CI.
#
# Usage:  ./platform/scripts/e2e-local.sh
#
# Prerequisites: docker, kind, helm, kubectl
# Pass extra Playwright args after --:  ./platform/scripts/e2e-local.sh -- --project=api
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLATFORM_DIR="$REPO_ROOT/platform"
KIND_CLUSTER="archestra-e2e-local"
KIND_CONFIG="$REPO_ROOT/.github/kind.yaml"
HELM_VALUES="$REPO_ROOT/.github/values-ci.yaml"
PLATFORM_IMAGE="archestra-platform:e2e-local"
MCP_BASE_IMAGE="mcp-server-base:e2e-local"
KIND_NODE_IMAGE="kindest/node:v1.34.3@sha256:08497ee19eace7b4b5348db5c6a1591d7752b164530a36f855cb0f2bdcbadd48"

# Playwright args: everything after "--", or default to chromium + api
PLAYWRIGHT_ARGS=""
if [[ "$*" == *"--"* ]]; then
  PLAYWRIGHT_ARGS="${*#*-- }"
else
  PLAYWRIGHT_ARGS="--project=chromium --project=api"
fi

cleanup() {
  echo ""
  echo "=== Tearing down Kind cluster '$KIND_CLUSTER' ==="
  kind delete cluster --name "$KIND_CLUSTER" 2>/dev/null || true
}
trap cleanup EXIT

# ---------- Preflight checks ----------
for cmd in docker kind helm kubectl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found in PATH" >&2
    exit 1
  fi
done

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon is not running" >&2
  exit 1
fi

echo "=== Building platform Docker image ==="
mkdir -p "$PLATFORM_DIR/prev-static-assets"
docker build -t "$PLATFORM_IMAGE" "$PLATFORM_DIR"

echo "=== Building MCP server base image ==="
docker build -t "$MCP_BASE_IMAGE" "$PLATFORM_DIR/mcp_server_docker_image"

echo "=== Creating Kind cluster '$KIND_CLUSTER' ==="
# Delete existing cluster with same name (idempotent)
kind delete cluster --name "$KIND_CLUSTER" 2>/dev/null || true

# Create a patched kind config with our cluster name
KIND_CONFIG_TMP=$(mktemp)
sed "s/name: archestra-ci-cluster/name: $KIND_CLUSTER/" "$KIND_CONFIG" > "$KIND_CONFIG_TMP"
kind create cluster --name "$KIND_CLUSTER" --config "$KIND_CONFIG_TMP" --image "$KIND_NODE_IMAGE"
rm -f "$KIND_CONFIG_TMP"

echo "=== Loading images into Kind ==="
kind load docker-image "$PLATFORM_IMAGE" --name "$KIND_CLUSTER" &
KIND_LOAD_PLATFORM=$!
kind load docker-image "$MCP_BASE_IMAGE" --name "$KIND_CLUSTER" &
KIND_LOAD_MCP=$!
wait $KIND_LOAD_PLATFORM $KIND_LOAD_MCP

echo "=== Deploying e2e test dependencies (WireMock, Keycloak, Vault) ==="
helm install e2e-tests "$PLATFORM_DIR/helm/e2e-tests" --wait --timeout=2m &
E2E_DEPS_PID=$!

echo "=== Deploying Archestra platform via Helm ==="
helm install archestra-platform "$PLATFORM_DIR/helm/archestra" \
  --values "$HELM_VALUES" \
  --set "archestra.image=$PLATFORM_IMAGE" \
  --set "archestra.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE=$MCP_BASE_IMAGE" \
  --atomic --timeout=5m

echo "=== Waiting for e2e dependencies ==="
wait $E2E_DEPS_PID

echo "=== Waiting for pods to be ready ==="
kubectl wait --for=condition=Ready pods -l app.kubernetes.io/name=archestra-platform --timeout=120s

echo "=== Verifying services ==="
curl --retry 10 --retry-delay 2 --retry-connrefused -sf http://localhost:9000/health > /dev/null
echo "Backend: OK"
curl --retry 10 --retry-delay 2 --retry-connrefused -sf http://localhost:3000/ > /dev/null
echo "Frontend: OK"

echo ""
echo "=== Running Playwright E2E tests ==="

# Resolve Playwright version from package.json
PW_VERSION=$(sed -n 's/.*"@playwright\/test": "\^*~*\([0-9.]*\)".*/\1/p' "$PLATFORM_DIR/e2e-tests/package.json")

docker run --rm \
  --network host \
  --ipc=host \
  -v "$REPO_ROOT:/work" \
  -w "/work/platform" \
  -e CI=true \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$HOME/.kube:/root/.kube:ro" \
  -e KUBECONFIG=/root/.kube/config \
  "mcr.microsoft.com/playwright:v${PW_VERSION}-noble" \
  /bin/bash -c "corepack enable && corepack prepare pnpm@10.24.0 --activate && pnpm test:e2e -- $PLAYWRIGHT_ARGS"

echo ""
echo "=== E2E tests complete ==="
