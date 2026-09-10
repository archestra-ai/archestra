---
name: archestra-dev-e2e
description: Use when writing, debugging, or running Archestra Playwright e2e tests, API/UI fixtures, WireMock-backed tests, local/CI e2e setup, or test selectors.
---

# Archestra E2E Testing

Use this skill for files under `platform/e2e-tests/` and for frontend/backend changes that require Playwright coverage.

Run commands from `platform/` unless specifically instructed otherwise.

## Commands

For the Docker-lite environment used by most CI specs:

```bash
pnpm test:e2e:lite:up
pnpm test:e2e:lite -- --project=chromium tests/agents.spec.ts
pnpm test:e2e:lite:down
```

The harness refuses to start if another stack holds its ports. Stop that stack before starting lite.

For an existing Tilt development stack:

```bash
tilt trigger e2e-test-dependencies
pnpm test:e2e
```

`tilt trigger e2e-test-dependencies` starts the e2e dependency stack via the `helm/e2e-tests` chart: WireMock, Keycloak (with pre-configured test users), Vault, and mock MCP servers. It does not seed the database.

Against the Tilt stack, e2e tests use the development database. Local data can make e2e tests fail locally.

Check WireMock health at `http://localhost:9092/__admin/health`.

## WireMock environment variables

Use port `9092` for the Tilt e2e dependency setup. Stub mappings live under provider-prefixed paths, so the base URL must carry the provider prefix:

```bash
ARCHESTRA_OPENAI_BASE_URL=http://localhost:9092/openai/v1
ARCHESTRA_ANTHROPIC_BASE_URL=http://localhost:9092/anthropic
ARCHESTRA_GEMINI_BASE_URL=http://localhost:9092/gemini
```

`platform/.env.example` lists the same block for every stubbed provider (vllm, ollama, cerebras, zhipuai, cohere, mistral, ...) — copy from there rather than guessing a prefix.

## Local and CI setup

- Local e2e dependencies deploy through `dev/Tiltfile.test`, which installs the `helm/e2e-tests` chart (`helm upgrade --install e2e-tests`) and port-forwards WireMock to `9092`.
- CI splits into lite (a quickstart-mode container with sidecars), host-Kubernetes (Kind + Helm for host kubectl, NetworkPolicy, and Helm fixtures), and pristine quickstart (keyless onboarding). See `.github/workflows/platform-e2e-tests.yml` from the repo root.
- Merge-queue/label runs cover Chromium; nightly/manual runs additionally cover the Firefox/WebKit-tagged specs.
- CI kind config is `.github/kind.yaml`.
- CI Helm values are `.github/values-ci.yaml`.
- CI NodePort services use frontend `3000`, backend `9000`, and metrics `9050`.
- `drizzle-kit check`, codegen, and db-migration validation run in the `platform-lint-and-unit-tests` job of `.github/workflows/on-pull-requests.yml`, not in the e2e workflow — a red check there is not an e2e failure.

## Registering a spec

`e2e-tests/playwright.config.ts` uses explicit `testMatch` lists. Add a new spec to the matching list (`uiTestMatch`, `apiTestMatch`, `apiK8sTestMatch`, or its dedicated project); naming it `*.spec.ts` alone does not register it. Confirm discovery without starting the stack:

```bash
pnpm --dir e2e-tests exec playwright test --list --project=chromium tests/your-spec.spec.ts
```

Choose the project that should run the spec and confirm it appears in the output.

## Fixtures

- Use the Playwright fixtures pattern.
- API fixtures live in `e2e-tests/tests/api-fixtures.ts` — import relative to the spec's location (`./api-fixtures` from `tests/`, `../api-fixtures` from a subdirectory like `tests/llm-proxy/`). They include `makeApiRequest`, `createAgent`, `deleteAgent`, `createApiKey`, `deleteApiKey`, `createToolInvocationPolicy`, `deleteToolInvocationPolicy`, `createTrustedDataPolicy`, and `deleteTrustedDataPolicy`.
- UI fixtures live in `e2e-tests/fixtures.ts` — import relative to the spec's location (`../fixtures` from `tests/`). They include `goToPage` and `makeRandomString`.
- API behavior that `app.inject` + PGlite can cover belongs in backend Vitest route tests (#6155). Keep Playwright for browser flows and behavior requiring the real stack, such as host kubectl, NetworkPolicy enforcement, or Helm fixtures.

Example:

```typescript
import { test } from "./api-fixtures";

test("API example", async ({ request, createAgent, deleteAgent }) => {
  const response = await createAgent(request, "Test Agent", "org");
  const agent = await response.json();
  // test logic...
  await deleteAgent(request, agent.id);
});
```

## Locator best practices

Prefer Playwright's recommended locators over raw `locator()` calls. In priority order:

1. `page.getByRole()` - accessible elements by ARIA role, such as buttons, links, and headings.
2. `page.getByText()` - text content.
3. `page.getByLabel()` - form controls by label.
4. `page.getByPlaceholder()` - input elements by placeholder.
5. `page.getByTestId()` - custom test IDs using `E2eTestId` constants from `@archestra/shared`.

Avoid raw CSS selectors, XPath selectors, and arbitrary timeouts. Use Playwright auto-waiting instead.

```typescript
// good
await page.getByRole("button", { name: /Submit/i }).click();
await page.getByLabel(/Email/i).fill("test@example.com");
await page.getByTestId(E2eTestId.CreateAgentButton).click();

// avoid
await page.locator(".submit-btn").click();
await page.locator("#email-input").fill("test@example.com");
await page.waitForTimeout(1000); // use auto-waiting instead
```

Reference: https://playwright.dev/docs/locators#quick-guide
