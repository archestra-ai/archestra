#!/bin/bash
# Copyright 2026 Archestra
#
# Standalone E2E Test Runner (extracted from run_tests_sequentially.sh Phase 4)

set -e # Exit immediately if a command exits with a non-zero status.

# --- Configuration ---
DELAY_SECONDS=30
LOG_BOLD="\033[1m"
LOG_BLUE="\033[1;34m"
LOG_GREEN="\033[1;32m"
LOG_YELLOW="\033[1;33m"
LOG_RESET="\033[0m"

# --- Cleanup Handler ---
cleanup() {
  echo -e "\n${LOG_BLUE}${LOG_BOLD}>>> Phase 5: Cleanup (Auto)${LOG_RESET}"
  echo -e "${LOG_BOLD}  [STEP] Cleaning up processes and ports...${LOG_RESET}"
  fuser -k 9000/tcp 3000/tcp 9050/tcp > /dev/null 2>&1 || true
  docker stop archestra-wiremock > /dev/null 2>&1 || true
  echo -e "  [INFO] Cleanup complete."
}
trap cleanup EXIT
# 0. Prep: Kill stale processes
echo -e "${LOG_BOLD}  [STEP] Cleaning stale processes on ports 9000, 3000, 9050${LOG_RESET}"
fuser -k 9000/tcp 3000/tcp 9050/tcp || true


# --- Logging Functions ---
log_section() {
  echo -e "\n${LOG_BLUE}${LOG_BOLD}>>> $1${LOG_RESET}"
}

log_step() {
  echo -e "${LOG_BOLD}  [STEP] $1${LOG_RESET}"
}

log_info() {
  echo -e "  [INFO] $1"
}

log_success() {
  echo -e "\n${LOG_GREEN}${LOG_BOLD}🎉 $1${LOG_RESET}"
}

wait_for_resources() {
  log_info "Waiting ${DELAY_SECONDS}s for system resources to settle..."
  sleep ${DELAY_SECONDS}
}

wait_for_server() {
  log_info "Waiting for backend server at localhost:9000..."
  for i in {1..120}; do
    if curl -s http://localhost:9000/health > /dev/null; then
      log_success "Backend is up!"
      return 0
    fi
    sleep 2
  done
  echo "Backend failed to start."
  exit 1
}

# --- Environment Setup ---
log_section "Phase 0: Environment Setup"

log_step "Activating Conda Environment"
source /home/samer/anaconda3/etc/profile.d/conda.sh
conda activate archestra

log_step "Exporting Environment Variables"
export ARCHESTRA_OPENAI_BASE_URL=http://localhost:9092/openai/v1
export ARCHESTRA_ANTHROPIC_BASE_URL=http://localhost:9092/anthropic
export ARCHESTRA_GEMINI_BASE_URL=http://localhost:9092/gemini
export ARCHESTRA_COHERE_BASE_URL=http://localhost:9092/cohere
export ARCHESTRA_CEREBRAS_BASE_URL=http://localhost:9092/cerebras/v1
export ARCHESTRA_MISTRAL_BASE_URL=http://localhost:9092/mistral/v1
export ARCHESTRA_VLLM_BASE_URL=http://localhost:9092/vllm/v1
export ARCHESTRA_OLLAMA_BASE_URL=http://localhost:9092/ollama/v1
export ARCHESTRA_ZHIPUAI_BASE_URL=http://localhost:9092/zhipuai/api/paas/v4
export ARCHESTRA_BEDROCK_BASE_URL=http://localhost:9092/bedrock
export ARCHESTRA_OPENROUTER_BASE_URL=http://localhost:9092/openrouter/api/v1
export ARCHESTRA_CHAT_OPENAI_API_KEY="openai-tool-persistence"
export ARCHESTRA_CHAT_ANTHROPIC_API_KEY="anthropic-tool-persistence"
export ARCHESTRA_CHAT_GEMINI_API_KEY="gemini-tool-persistence"
export ARCHESTRA_CHAT_COHERE_API_KEY="cohere-tool-persistence"
export ARCHESTRA_CHAT_CEREBRAS_API_KEY="cerebras-tool-persistence"
export ARCHESTRA_CHAT_MISTRAL_API_KEY="mistral-tool-persistence"
export ARCHESTRA_CHAT_OLLAMA_API_KEY="ollama-tool-persistence"
export ARCHESTRA_CHAT_VLLM_API_KEY="vllm-tool-persistence"
export ARCHESTRA_CHAT_ZHIPUAI_API_KEY="zhipuai-tool-persistence"
export ARCHESTRA_CHAT_OPENROUTER_API_KEY="openrouter-tool-persistence"
export ARCHESTRA_METRICS_SECRET=foo-bar
export ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED=true
export ARCHESTRA_ORCHESTRATOR_SKIP_TLS_VERIFY=true
export ARCHESTRA_MOCK_K8S=true
export FEATURES_BROWSER_STREAMING_ENABLED=true

log_step "Checking Core Database (Postgres)"
if docker ps --filter "name=archestra-postgres" --format '{{.Names}}' | grep -q "archestra-postgres"; then
    log_info "archestra-postgres container is running."
elif docker ps -a --filter "name=archestra-postgres" --format '{{.Names}}' | grep -q "archestra-postgres"; then
    log_info "Starting existing archestra-postgres container..."
    docker start archestra-postgres
else
    log_info "Creating and starting archestra-postgres container..."
    docker run -d --name archestra-postgres -p 5432:5432 -e POSTGRES_PASSWORD=archestra_dev_password -e POSTGRES_USER=archestra -e POSTGRES_DB=archestra_dev postgres:15
fi
wait_for_resources

log_step "Setting up WireMock Docker Container"
docker rm -f archestra-wiremock > /dev/null 2>&1 || true
docker run -d --name archestra-wiremock -p 9092:8080 -v $(pwd)/helm/e2e-tests/mappings:/home/wiremock/mappings wiremock/wiremock:3.2.0
wait_for_resources

log_step "Applying Database Migrations"
pnpm db:migrate
wait_for_resources

log_step "Seeding Mock Data"
pnpm db:seed:mock-data
wait_for_resources

# --- START APP STACK ---
log_section "Starting Application Stack for E2E Tests"
log_info "Starting Backend Stack..."
pnpm dev > platform_e2e.log 2>&1 &
wait_for_server
wait_for_resources

# Step 4: End-to-End (E2E) Tests
log_section "Phase 4: End-to-End (E2E) Tests"
log_info "Note: Validating API and UI functionality."

log_step "E2E: API Suites (Tests)"
# Excluding orchestrator tests as they require K8s environment
(cd e2e-tests && pnpm playwright test tests/api --grep-invert "Orchestrator|orchestrator|SSO|sso|ChatSettings" --reporter=line)
wait_for_resources

log_step "E2E: UI Suites"
(cd e2e-tests && pnpm playwright test tests/ui --reporter=line)
wait_for_resources

log_step "E2E: Targeted Provider Tests (OpenRouter)"
pnpm --filter @e2e-tests exec playwright test --grep Openrouter --reporter=line
wait_for_resources

log_success "E2E test phase completed successfully!"
