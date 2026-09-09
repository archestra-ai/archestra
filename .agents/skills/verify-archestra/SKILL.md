---
name: verify-archestra
description: Verify Archestra agent configuration and browser chat behavior with the real UI, Playwright fixtures, and WireMock-backed LLM responses.
---

# Verify Archestra agents and chat

Use this skill to verify user-visible agent configuration and browser chat behavior. Read [the feature index](features/README.md) first, then the feature files named by the task. Run commands from `platform/` and keep one browser driver per instance.

## Launch

Prefer the isolated lite stack because its database, provider keys, conversations, and agents are disposable:

```bash
mise x node@24 -- pnpm test:e2e:lite:up
```

The command owns the Docker network `archestra-lite-net`, the `archestra-lite`, `e2e-tests-wiremock`, and `e2e-tests-keycloak` containers, and the embedded Kind control plane. It refuses to start when another process owns ports 3000, 9000, 9050, 9092, or 30081. Its readiness signal is:

```text
Lite e2e stack is up: frontend http://localhost:3000, backend http://localhost:9000
```

If an existing Tilt stack is intentionally being used, adopt it instead of launching another instance:

```bash
mise x node@24 -- pnpm dev:stack:status
tilt trigger e2e-test-dependencies
```

The second command is required only for WireMock-backed chat recipes. Do not run Playwright's setup projects against a shared development database unless the task authorizes their organization/user/team fixture changes. Non-persisting browser checks, such as the unsaved-change recipe, are safe against an adopted stack.

## Doctor

Record the revision and dirty state, then verify runtime, instance identity, services, and authentication before driving:

```bash
git rev-parse HEAD
git status --short
mise x node@24 -- node --version
curl -fsS http://127.0.0.1:9000/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
curl -fsS http://127.0.0.1:9092/__admin/health
```

Expected results are Node 24, backend health success, frontend HTTP 200 or its normal redirect, and WireMock health success for chat-send recipes. For an isolated run, also require `docker inspect archestra-lite` to identify the tested container. For an adopted Tilt run, require `mise x node@24 -- pnpm dev:stack:status` to name the expected checkout, branch, and URL.

Open `/agents` in the browser and confirm the expected authenticated user is visible. Open `/chat` and require the `chat-prompt-textarea` test id before declaring the composer ready. A login page, wrong user, wrong checkout, missing roster, or provider selector without a WireMock key is a failed doctor check, not feature evidence.

## Drive

Use the existing Playwright fixtures and semantic locators documented in each feature file. The two primary automated entry points are:

```bash
mise x node@24 -- pnpm test:e2e:lite -- --project=chromium tests/agents.spec.ts --grep 'can create and delete an agent'
mise x node@24 -- pnpm test:e2e:lite -- --project=chromium tests/chat.spec.ts --grep 'can send a message and receive a response from Anthropic'
```

The first covers the `/agents` creation entry point, routed configuration sections, the legacy edit redirect, list/detail navigation, and cleanup. The second covers a real browser conversation against the real backend with a WireMock-backed Anthropic key and model. Neither command substitutes for the additional persistence and negative recipes in the feature files.

Use `E2eTestId` values from `platform/shared/e2e-test-ids.ts` and prefer `getByRole`, `getByLabel`, `getByText`, and `getByTestId`. Wait for observable state or a URL transition; the agent list and wizard can render before hydration, so a click that does not change state must not be counted.

## Evidence

Write artifacts under `.artifacts/verify-archestra/<UTC-run-id>/` at the repository root. This location is ignored by Git and is not removed when the lite stack is torn down.

```bash
VERIFY_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
VERIFY_RUN_DIR="$(git rev-parse --show-toplevel)/.artifacts/verify-archestra/${VERIFY_RUN_ID}"
mkdir -p "$VERIFY_RUN_DIR"
```

For automated runs, add an HTML report without replacing the normal line output:

```bash
PLAYWRIGHT_HTML_OUTPUT_DIR="$VERIFY_RUN_DIR/playwright-report" PLAYWRIGHT_HTML_OPEN=never mise x node@24 -- pnpm test:e2e:lite -- --project=chromium tests/agents.spec.ts --grep 'can create and delete an agent' --reporter=line,html
```

For browser-driven recipes, save screenshots after the action, after the expected result, and after the persistence read. Do not treat a screenshot of a filled form as proof that it saved. Record a `run-report.md` beside the artifacts with one row per exercised entry point and these fields:

- feature and sub-feature ID
- entry-point ID
- status: Passed, Failed, Blocked, or Untested
- observed result
- evidence path
- Git revision and, when available, the displayed app version or container image

## Cleanup

Delete only fixtures created by the run. The existing `agents.spec.ts` removes its agent. Chat specs can leave conversations and provider fixtures; keep those inside the isolated stack and remove the stack after evidence capture:

```bash
mise x node@24 -- pnpm test:e2e:lite:down
```

Confirm the owned containers and ports are gone, then confirm `$VERIFY_RUN_DIR` and its report are still readable. Never tear down an adopted Tilt stack or delete a pre-existing agent, provider key, conversation, user, or team. On a shared instance, restore every changed field to its captured original value and separately verify the second read.
