# E2E Tests Guide

This guide explains how to run and verify E2E tests locally.

## Prerequisites

1. **Docker** - Required for running Kind cluster and WireMock
2. **Kind (Kubernetes in Docker)** - For local Kubernetes cluster
3. **kubectl** - Kubernetes command-line tool
4. **Helm** - For deploying the platform
5. **Node.js & pnpm** - For running Playwright tests
6. **Playwright browsers** - Installed via `pnpm exec playwright install`

## Quick Start

### 1. Install Playwright Browsers

```bash
cd platform/e2e-tests
pnpm exec playwright install
```

### 2. Set Up Test Environment

The E2E tests require a running Archestra Platform instance. You have two options:

#### Option A: Use CI Setup (Recommended for Testing)

The tests are designed to run against a Kind cluster with the platform deployed via Helm, similar to CI:

```bash
# From repository root
# This uses the GitHub Action setup (you can adapt it for local use)
# Or manually:
kind create cluster --config .github/kind.yaml --name archestra-ci-cluster
helm install archestra-platform ./platform/helm/archestra \
  --values .github/values-ci.yaml \
  --set archestra.image=archestra/platform:latest
helm install e2e-tests ./platform/helm/e2e-tests
```

#### Option B: Run Against Local Development Instance

If you have the platform running locally (frontend on `localhost:3000`, backend on `localhost:9000`):

```bash
# Ensure platform is running locally
# Frontend: http://localhost:3000
# Backend: http://localhost:9000
```

**Note:** For LLM proxy tests (including MiniMax), you'll need WireMock running to mock LLM provider responses.

### 3. Run All E2E Tests

```bash
# From repository root
pnpm test:e2e

# Or from e2e-tests directory
cd platform/e2e-tests
pnpm test:e2e
```

### 4. Run Tests with UI (Interactive Mode)

```bash
cd platform/e2e-tests
pnpm test:e2e:ui
```

This opens Playwright's interactive UI where you can:
- See tests running in real-time
- Debug tests step-by-step
- View test results and traces

### 5. View Test Report

```bash
cd platform/e2e-tests
pnpm test:e2e:report
```

## Running Specific Test Suites

### Run Only API Tests

```bash
cd platform/e2e-tests
pnpm exec playwright test --project=api
```

### Run Only UI Tests

```bash
cd platform/e2e-tests
pnpm exec playwright test --project=chromium
```

### Run MiniMax LLM Proxy Tests

```bash
cd platform/e2e-tests
pnpm exec playwright test --project=api --grep "MiniMax"
```

Or run a specific MiniMax test file:

```bash
cd platform/e2e-tests
pnpm exec playwright test tests/api/llm-proxy/tool-invocation.spec.ts --grep "MiniMax"
```

### Run All LLM Proxy Tests

```bash
cd platform/e2e-tests
pnpm exec playwright test tests/api/llm-proxy/
```

## Test Projects

The E2E tests are organized into projects:

- **setup-admin** - Sets up admin authentication
- **setup-users** - Creates test users (editor, member)
- **setup-teams** - Creates test teams
- **api** - API integration tests (including LLM proxy tests)
- **chromium** - UI tests on Chrome
- **firefox** - UI tests on Firefox (only tests tagged with `@firefox`)
- **webkit** - UI tests on Safari (only tests tagged with `@webkit`)
- **sso** - SSO provider tests
- **credentials-with-vault** - Vault integration tests

## LLM Proxy Test Configuration

The LLM proxy tests (including MiniMax) require:

1. **WireMock** - Running on `http://localhost:9092` (or configured via `WIREMOCK_BASE_URL`)
2. **WireMock Stub Mappings** - Located in `platform/helm/e2e-tests/mappings/`
3. **Platform Configuration** - LLM provider base URLs pointing to WireMock

### MiniMax Test Stubs

MiniMax tests use these WireMock stubs:

- `minimax-models-list.json` - Mocks `/models` endpoint
- `minimax-tool-persistence.json` - Tool persistence test
- `minimax-blocks-tool-untrusted-data.json` - Tool invocation blocking
- `minimax-allows-archestra-untrusted-context.json` - Untrusted context handling
- `minimax-allows-regular-after-archestra.json` - Regular tool calls
- `minimax-compression-enabled.json` - TOON compression enabled
- `minimax-compression-disabled.json` - TOON compression disabled
- `minimax-model-optimization-*.json` - Model optimization scenarios
- `minimax-token-cost-limit-test.json` - Token cost limits

### Verify WireMock is Running

```bash
# Check if WireMock is accessible
curl http://localhost:9092/__admin/mappings

# Or check via kubectl if deployed in cluster
kubectl port-forward svc/e2e-tests-wiremock 9092:8080
curl http://localhost:9092/__admin/mappings
```

## Verifying Test Setup

### 1. Check Platform is Running

```bash
# Frontend
curl http://localhost:3000

# Backend health check
curl http://localhost:9000/health
```

### 2. Check Test Configuration

```bash
cd platform/e2e-tests
# Verify Playwright config
cat playwright.config.ts

# Check constants
cat consts.ts
```

### 3. Run a Simple Test

```bash
cd platform/e2e-tests
# Run a single simple test to verify setup
pnpm exec playwright test tests/api/metrics.spec.ts
```

### 4. Check Authentication Setup

The tests use pre-authenticated sessions stored in:
- `platform/e2e-tests/playwright/.auth/admin.json`
- `platform/e2e-tests/playwright/.auth/editor.json`
- `platform/e2e-tests/playwright/.auth/member.json`

These are created by the setup projects. If they're missing, run:

```bash
cd platform/e2e-tests
pnpm exec playwright test --project=setup-admin
pnpm exec playwright test --project=setup-users
pnpm exec playwright test --project=setup-teams
```

## Common Issues and Troubleshooting

### Issue: Tests fail with "ECONNREFUSED" or connection errors

**Solution:**
- Ensure the platform is running and accessible
- Check `UI_BASE_URL` and `API_BASE_URL` in `consts.ts` match your setup
- Verify ports 3000 (frontend) and 9000 (backend) are not blocked

### Issue: LLM proxy tests fail with WireMock errors

**Solution:**
- Ensure WireMock is running: `curl http://localhost:9092/__admin/mappings`
- Check WireMock stub mappings are loaded
- Verify LLM provider base URLs in platform config point to WireMock
- For MiniMax: Check `ARCHESTRA_MINIMAX_BASE_URL` is set to WireMock URL

### Issue: Authentication fails

**Solution:**
- Re-run setup projects to regenerate auth files
- Check admin credentials in `.env` or environment variables
- Verify `ARCHESTRA_AUTH_ADMIN_EMAIL` and `ARCHESTRA_AUTH_ADMIN_PASSWORD`

### Issue: Tests timeout

**Solution:**
- Increase timeout in `playwright.config.ts` (default: 60s)
- Check platform logs for errors
- Verify database is accessible and migrations are applied

### Issue: MiniMax tests fail

**Solution:**
- Verify WireMock stubs for MiniMax are present in `platform/helm/e2e-tests/mappings/`
- Check `ARCHESTRA_MINIMAX_BASE_URL` points to WireMock
- Ensure `ARCHESTRA_CHAT_MINIMAX_API_KEY` is set (can be `test-key` for WireMock)
- Review test logs for specific error messages

## Test Structure

### LLM Proxy Test Suites

1. **tool-invocation.spec.ts** - Tests tool invocation policies
2. **tool-persistence.spec.ts** - Tests tool persistence across requests
3. **tool-result-compression.spec.ts** - Tests TOON compression
4. **model-optimization.spec.ts** - Tests model optimization rules
5. **token-cost-limits.spec.ts** - Tests token cost limit enforcement

Each suite tests multiple providers (OpenAI, Anthropic, Gemini, Cerebras, vLLM, Ollama, **MiniMax**).

### MiniMax Test Configuration

MiniMax tests use:
- **Endpoint**: `/v1/minimax/{agentId}/chat/completions`
- **Model**: `MiniMax-M2.1` (for most tests)
- **Headers**: `Authorization: Bearer {wiremockStub}`
- **WireMock Base URL**: `http://e2e-tests-wiremock:8080/minimax/v1` (in CI)

## CI/CD Integration

In CI, tests run in a Docker container with:
- Kind cluster pre-configured
- Platform deployed via Helm
- WireMock deployed as a service
- All environment variables configured

To replicate locally, use the same setup as `.github/actions/setup-archestra-platform/action.yml`.

## Additional Resources

- [Playwright Documentation](https://playwright.dev/)
- [WireMock Documentation](https://wiremock.org/)
- [Kind Documentation](https://kind.sigs.k8s.io/)
