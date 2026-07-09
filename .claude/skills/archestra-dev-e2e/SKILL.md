---
name: archestra-dev-e2e
description: Use when writing, debugging, or running Archestra Playwright e2e tests, API/UI fixtures, WireMock-backed tests, local/CI e2e setup, or test selectors.
---

# Archestra E2E Testing

Use this skill for files under `platform/e2e-tests/` and for frontend/backend changes that require Playwright coverage.

Run commands from `platform/` unless specifically instructed otherwise.

## Commands

```bash
pnpm test:e2e
tilt trigger e2e-test-dependencies
```

`tilt trigger e2e-test-dependencies` starts WireMock and seeds test data to the database.

In development, e2e tests use the development database. Local data can make e2e tests fail locally.

Check WireMock health at `http://localhost:9092/__admin/health`.

## WireMock environment variables

Use port `9092` for the Tilt e2e dependency setup:

```bash
ARCHESTRA_OPENAI_BASE_URL=http://localhost:9092/v1
ARCHESTRA_ANTHROPIC_BASE_URL=http://localhost:9092
ARCHESTRA_GEMINI_BASE_URL=http://localhost:9092
```

## Local and CI setup

- Local e2e dependencies deploy through `dev/Tiltfile.test`, which installs the `helm/e2e-tests` chart (`helm upgrade --install e2e-tests`) and port-forwards WireMock to `9092`.
- CI uses a kind cluster and Helm deployment.
- CI kind config is `.github/kind.yaml`.
- CI Helm values are `.github/values-ci.yaml`.
- CI NodePort services use frontend `3000`, backend `9000`, and metrics `9050`.
- CI e2e checks include `drizzle-kit check`, codegen, and database migrations.

## Fixtures

- Use the Playwright fixtures pattern.
- API fixtures live in `e2e-tests/tests/api-fixtures.ts` — import relative to the spec's location (`./api-fixtures` from `tests/`, `../api-fixtures` from a subdirectory like `tests/llm-proxy/`). They include `makeApiRequest`, `createAgent`, `deleteAgent`, `createApiKey`, `deleteApiKey`, `createToolInvocationPolicy`, `deleteToolInvocationPolicy`, `createTrustedDataPolicy`, and `deleteTrustedDataPolicy`.
- UI fixtures live in `e2e-tests/fixtures.ts` — import relative to the spec's location (`../fixtures` from `tests/`). They include `goToPage` and `makeRandomString`.
- Pure API tests (no browser needed) belong in the backend vitest suite as route tests, not in Playwright (#6155). Keep Playwright specs for flows that exercise the UI.

Example:

```typescript
import { test } from "./api-fixtures";

test("API example", async ({ request, createAgent, deleteAgent }) => {
  const response = await createAgent(request, "Test Agent");
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
