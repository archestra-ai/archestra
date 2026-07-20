#!/usr/bin/env bash
# Lite e2e harness: the platform as one quickstart-mode container plus
# WireMock and Keycloak sidecars. No host Kind cluster, no Helm, no Tilt —
# MCP-server installs work through the embedded Kind cluster the quickstart
# entrypoint provisions via the mounted docker socket.
#
# Covers the chromium / api / identity-providers Playwright projects. Not
# covered: api-k8s and vault-k8s (need the full Kind+Helm environment) and
# the @quickstart onboarding specs (need a key-less pristine instance; CI
# runs them in the separate quickstart job). See
# .github/workflows/platform-e2e-tests.yml.
#
# Usage:
#   scripts/e2e-lite.sh up                     start the stack, wait until healthy
#   scripts/e2e-lite.sh test [playwright args] run the lite suite (stack must be up);
#                                              with args, runs exactly those instead
#   scripts/e2e-lite.sh down                   remove the stack (incl. embedded Kind)
#
# Environment:
#   PLATFORM_IMAGE         image to run. Default: pull the prebuilt CI image for
#                          the current git tree when the platform/ checkout is
#                          clean, otherwise docker-build it locally.
#   MCP_SERVER_BASE_IMAGE  orchestrator base image for MCP server pods
#                          (default: the published :latest — the embedded Kind
#                          cluster pulls it straight from the registry).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(dirname "${SCRIPT_DIR}")"
REPO_ROOT="$(dirname "${PLATFORM_DIR}")"

REGISTRY="europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public"
MCP_SERVER_BASE_IMAGE="${MCP_SERVER_BASE_IMAGE:-${REGISTRY}/mcp-server-base:latest}"

NETWORK="archestra-lite-net"
PLATFORM_CONTAINER="archestra-lite"
# Sidecar names double as their docker-network DNS names and must match what
# the tests store in the DB for the backend to call (see e2e-tests/consts.ts
# and the E2E_* overrides in cmd_test below).
WIREMOCK_CONTAINER="e2e-tests-wiremock"
KEYCLOAK_CONTAINER="e2e-tests-keycloak"
# The quickstart entrypoint names its embedded Kind cluster archestra-mcp;
# its node runs as a sibling container we must clean up ourselves.
EMBEDDED_KIND_CONTAINER="archestra-mcp-control-plane"

KEYCLOAK_IMAGE="${REGISTRY}/keycloak:pr46048-5afbf42"
WIREMOCK_IMAGE="wiremock/wiremock:3.13.1"

# Pull from the public registry ignoring configured credential helpers: a
# stale `gcloud auth configure-docker` helper otherwise fails anonymous pulls
# with a reauthentication error. Falls back to a normal pull.
pull_public() {
  DOCKER_CONFIG="$(mktemp -d)" docker pull --quiet "$1" > /dev/null 2>&1 \
    || docker pull --quiet "$1" > /dev/null
}

wait_for() {
  local name="$1" url="$2" attempts="$3"
  for ((i = 1; i <= attempts; i++)); do
    if curl -sf "${url}" > /dev/null 2>&1; then
      echo "${name} is ready"
      return 0
    fi
    sleep 2
  done
  echo "ERROR: ${name} not ready after $((attempts * 2))s (${url})" >&2
  docker logs "${PLATFORM_CONTAINER}" --tail=100 2>&1 || true
  return 1
}

resolve_platform_image() {
  if [[ -n "${PLATFORM_IMAGE:-}" ]]; then
    echo "${PLATFORM_IMAGE}"
    return
  fi
  # Clean checkout: reuse the image CI already built for this exact tree.
  # Two candidate tags cover both generations of the CI reuse key (full
  # ./platform tree, and ./platform minus e2e-tests).
  if [[ -z "$(cd "${REPO_ROOT}" && git status --porcelain -- platform ':(exclude)platform/e2e-tests')" ]]; then
    local full_tree excl_tree tag
    full_tree=$(cd "${REPO_ROOT}" && git rev-parse "HEAD:platform")
    excl_tree=$(cd "${REPO_ROOT}" && git ls-tree "HEAD:platform" | grep -v $'\te2e-tests$' | git hash-object --stdin)
    for tag in "tree-${excl_tree}" "tree-${full_tree}"; do
      if pull_public "${REGISTRY}/platform:${tag}" 2> /dev/null; then
        echo "${REGISTRY}/platform:${tag}"
        return
      fi
    done
    echo "No prebuilt CI image for this tree; building locally" >&2
  else
    echo "platform/ has local changes; building image locally" >&2
  fi
  docker build -t archestra-platform:e2e-lite "${PLATFORM_DIR}" >&2
  echo "archestra-platform:e2e-lite"
}

cmd_up() {
  cmd_down quiet

  # The harness owns these host ports. A dev stack (tilt up / pnpm dev) uses
  # 3000/9000 too — if anything still answers, the health checks below and
  # the tests would silently talk to THAT app instead of this stack.
  local port
  for port in 3000 9000 9050 9092 30081; do
    if curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:${port}/" 2> /dev/null \
      || nc -z 127.0.0.1 "${port}" > /dev/null 2>&1; then
      echo "ERROR: something is already listening on 127.0.0.1:${port} (a dev stack?)." >&2
      echo "Stop it first — the lite e2e stack needs ports 3000, 9000, 9050, 9092, 30081." >&2
      exit 1
    fi
  done

  local image
  image=$(resolve_platform_image)
  echo "Platform image: ${image}"
  docker image inspect "${image}" > /dev/null 2>&1 || pull_public "${image}"
  docker image inspect "${KEYCLOAK_IMAGE}" > /dev/null 2>&1 || pull_public "${KEYCLOAK_IMAGE}"

  docker network create "${NETWORK}" > /dev/null

  docker run -d \
    --name "${WIREMOCK_CONTAINER}" \
    --network "${NETWORK}" \
    -p 127.0.0.1:9092:8080 \
    -v "${PLATFORM_DIR}/helm/e2e-tests/mappings:/home/wiremock/mappings:ro" \
    "${WIREMOCK_IMAGE}" \
    --global-response-templating --disable-gzip --verbose > /dev/null

  # Same realm fixture the Kind+Helm CI environment imports.
  docker run -d \
    --name "${KEYCLOAK_CONTAINER}" \
    --network "${NETWORK}" \
    -p 127.0.0.1:30081:8080 \
    -e KEYCLOAK_ADMIN=admin \
    -e KEYCLOAK_ADMIN_PASSWORD=admin \
    -e KC_HTTP_PORT=8080 \
    -e KC_HEALTH_ENABLED=true \
    -e KC_FEATURES=token-exchange:v1,admin-fine-grained-authz:v1,jwt-authorization-grant:v1,identity-assertion-jwt:v1 \
    -e KC_HOSTNAME=http://localhost:30081 \
    -e KC_HOSTNAME_STRICT=false \
    -e KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true \
    -v "${PLATFORM_DIR}/helm/e2e-tests/files/archestra-realm.json:/opt/keycloak/data/import/archestra-realm.json:ro" \
    "${KEYCLOAK_IMAGE}" \
    start-dev --import-realm > /dev/null

  docker run -d \
    --name "${PLATFORM_CONTAINER}" \
    --network "${NETWORK}" \
    -p 127.0.0.1:3000:3000 \
    -p 127.0.0.1:9000:9000 \
    -p 127.0.0.1:9050:9050 \
    --env-file "${SCRIPT_DIR}/e2e-lite-platform.env" \
    -e "ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE=${MCP_SERVER_BASE_IMAGE}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    "${image}" > /dev/null

  wait_for WireMock "http://127.0.0.1:9092/__admin/health" 15
  wait_for backend "http://127.0.0.1:9000/health" 120
  wait_for frontend "http://127.0.0.1:3000/" 30
  # Keycloak last: its ~40-60s realm import overlaps the platform boot.
  wait_for Keycloak "http://127.0.0.1:30081/realms/archestra/.well-known/openid-configuration" 60

  # Pre-warm the MCP server base image inside the embedded Kind node so the
  # first MCP-install spec doesn't pay the cold multi-hundred-MB pull (the
  # kubelet coalesces with an in-flight pull). Backgrounded: it overlaps the
  # test runner's own startup.
  docker exec "${EMBEDDED_KIND_CONTAINER}" crictl pull "${MCP_SERVER_BASE_IMAGE}" > /dev/null 2>&1 &

  echo "Lite e2e stack is up: frontend http://localhost:3000, backend http://localhost:9000"
}

cmd_test() {
  cd "${PLATFORM_DIR}/e2e-tests"
  export E2E_WIREMOCK_BASE_URL="http://127.0.0.1:9092"
  export E2E_WIREMOCK_INTERNAL_URL="http://${WIREMOCK_CONTAINER}:8080"
  export E2E_KEYCLOAK_BACKEND_URL="http://${KEYCLOAK_CONTAINER}:8080"
  if [[ $# -gt 0 ]]; then
    pnpm exec playwright test "$@"
    return
  fi
  # Same projects as the CI lite job. The @quickstart onboarding specs are
  # excluded: they need a key-less pristine instance (CI runs them in the
  # separate quickstart job), while this environment seeds provider keys.
  pnpm exec playwright test \
    --project=chromium --project=api --project=identity-providers \
    --grep-invert @quickstart
}

cmd_down() {
  docker rm -f \
    "${PLATFORM_CONTAINER}" "${WIREMOCK_CONTAINER}" "${KEYCLOAK_CONTAINER}" \
    "${EMBEDDED_KIND_CONTAINER}" > /dev/null 2>&1 || true
  docker network rm "${NETWORK}" > /dev/null 2>&1 || true
  if [[ "${1:-}" != "quiet" ]]; then
    echo "Lite e2e stack removed"
  fi
}

case "${1:-}" in
  up) cmd_up ;;
  test) shift; cmd_test "$@" ;;
  down) cmd_down ;;
  *)
    echo "Usage: $0 {up|test [playwright args]|down}" >&2
    exit 1
    ;;
esac
