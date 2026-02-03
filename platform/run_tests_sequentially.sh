#!/bin/bash
# Copyright 2026 Archestra
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# This script runs all tests mentioned in DEPENDENCIES.md sequentially.
# It breaks down tests into modules and adds delays between executions to ensure 
# reasonable resource utilization and stability on the local machine.
#
# Usage:
#   cd archestra/platform
#   ./run_tests_sequentially.sh

set -e # Exit immediately if a command exits with a non-zero status.

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


# --- Configuration ---
DELAY_SECONDS=30
LOG_BOLD="\033[1m"
LOG_BLUE="\033[1;34m"
LOG_GREEN="\033[1;32m"
LOG_YELLOW="\033[1;33m"
LOG_RESET="\033[0m"

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

# 1. Activate Conda Environment
log_step "Activating Conda Environment"
source /home/samer/anaconda3/etc/profile.d/conda.sh
conda activate archestra

# 2. Export Testing Environment Variables (WireMock Mappings)
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
export ARCHESTRA_MOCK_K8S=false
export FEATURES_BROWSER_STREAMING_ENABLED=true

# 3. Start Core Database (Postgres)
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

# 4. Setup WireMock
log_step "Setting up WireMock Docker Container"
docker rm -f archestra-wiremock > /dev/null 2>&1 || true
docker run -d --name archestra-wiremock -p 9092:8080 -v $(pwd)/helm/e2e-tests/mappings:/home/wiremock/mappings wiremock/wiremock:3.2.0
wait_for_resources

# 5. Database Setup (Migrate & Seed)
log_step "Applying Database Migrations"
pnpm db:migrate
wait_for_resources

log_step "Seeding Mock Data"
pnpm db:seed:mock-data
wait_for_resources

# NOTE: We intentionally DO NOT start the app stack here.
# Unit tests (Phase 1, 2, 3) should not require the full app stack running.
# We will start the stack before Phase 4 (E2E) to save resources.

log_section "Starting Sequential Test Execution with Resource Management"

# Step 1: Shared Modules
log_section "Phase 1: Shared Library"
log_step "Running @shared tests"
pnpm --filter @shared test --run
wait_for_resources

# Step 2: Backend Modules
log_section "Phase 2: Backend Modules"

log_step "Backend: Models"
(cd backend && pnpm vitest src/models --run)
wait_for_resources

log_step "Backend: Routes/Proxy (LLM Adapters)"
(cd backend && pnpm vitest src/routes/proxy --run)
wait_for_resources

log_step "Backend: Routes/Chat"
(cd backend && pnpm vitest src/routes/chat --run)
wait_for_resources

log_step "Backend: Other Routes"
(cd backend && pnpm vitest src/routes --exclude "src/routes/{proxy,chat}/**" --run)
wait_for_resources

log_step "Backend: Auth"
(cd backend && pnpm vitest src/auth --run)
wait_for_resources

log_step "Backend: Services & Agents"
(cd backend && pnpm vitest src/{services,agents} --run)
wait_for_resources

log_step "Backend: Knowledge Graph & MCP Runtime"
(cd backend && pnpm vitest src/{knowledge-graph,mcp-server-runtime} --run)
wait_for_resources

log_step "Backend: All Other Unit Tests"
# Exclude already run directories
(cd backend && pnpm vitest src --exclude "src/{models,routes,auth,services,agents,knowledge-graph,mcp-server-runtime}/**" --run)
wait_for_resources

# Step 3: Frontend Modules
log_section "Phase 3: Frontend Modules"

log_step "Frontend: Hooks & Lib"
(cd frontend && pnpm vitest src/{hooks,lib} --run)
wait_for_resources

log_step "Frontend: Components"
(cd frontend && pnpm vitest src/components --run)
wait_for_resources

log_step "Frontend: App Structure"
(cd frontend && pnpm vitest src/app --run)
wait_for_resources

log_step "Frontend: Other Tests"
(cd frontend && pnpm vitest src --exclude "src/{hooks,lib,components,app}/**" --run)
wait_for_resources

# --- START APP STACK ---
log_section "Starting Application Stack for E2E Tests"
if lsof -i :9000 >/dev/null; then
    log_info "Backend (port 9000) is already running."
    log_info "WARNING: Using existing backend instance. Ensure it is configured correctly."
else
    log_info "Starting Backend/Frontend Stack..."
    pnpm dev > platform.log 2>&1 &
    wait_for_server
    wait_for_resources
fi

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

log_success "All sequential test suites completed successfully!"

# --- Cleanup ---
log_section "Phase 5: Cleanup"
log_step "Cleaning up processes and ports..."
fuser -k 9000/tcp 3000/tcp 9050/tcp || true
docker stop archestra-wiremock || true
log_info "Cleanup complete."
