## Running e2e tests locally (lite harness)

The fastest way to run the suite locally — no Tilt, no Kind on the host, no
Helm. It boots the platform as one quickstart-mode container plus WireMock and
Keycloak sidecars, the exact stack CI's "Platform E2E Tests (Lite)" job uses:

```bash
cd platform
pnpm test:e2e:lite:up      # start the stack (pulls the prebuilt CI image on a clean checkout)
pnpm test:e2e:lite         # run the lite suite (chromium, api, identity-providers)
pnpm test:e2e:lite -- --project=chromium tests/agents.spec.ts   # or just one spec
pnpm test:e2e:lite:down    # tear everything down
```

Requirements: Docker running, `pnpm install` done. With uncommitted changes
under `platform/` the script docker-builds the image locally instead of
pulling. MCP-server installs work — the container provisions an embedded Kind
cluster through the mounted docker socket. On Apple Silicon the prebuilt CI
image is amd64 and runs emulated; if short UI timeouts flake, build a native
image (commit your changes and the script builds locally, or pass
`PLATFORM_IMAGE`).

Not covered here: the `api-k8s` and `vault-k8s` projects (host-cluster
kubectl, NetworkPolicy enforcement, Vault K8s auth, helm-deployed fixture
servers) need the Kind+Helm environment (`scripts/e2e-local.sh`), and the
`@quickstart` onboarding specs need a key-less pristine instance (CI runs
them in their own job; this stack seeds provider keys).

## Troubleshooting e2e tests that fail on CI

1. Go to the failing GitHub workflow run (e.g. from a PR check)
2. Click "Summary"

<img src="readme-images/e2e1.png" width="600" />

3. Scroll to the bottom and download the "playwright-report" artifact

<img src="readme-images/e2e2.png" width="600" />

4. Unzip the downloaded report
5. Open it with Playwright:
   ```bash
   npx playwright show-report <path-to-unzipped-report-folder>
   ```
6. The report opens automatically at `http://localhost:9323/`

<img src="readme-images/e2e3.png" width="600" />

7. Click on a failing test, scroll down, and click on the trace. The trace viewer lets you inspect step by step what happened during test execution.

<img src="readme-images/e2e4.png" width="600" />

## Running e2e tests locally via UI mode

1. Start Archestra with `tilt up`
2. In Tilt, click the trigger button on the `e2e-tests-ui` resource

<img src="readme-images/e2e5.png" width="600" />

3. Choose which projects to run. After a clean database, the `setup-*` projects are required on the first run (they create the users and teams that all other tests depend on). On subsequent runs you can disable them to save time.

<img src="readme-images/e2e6.png" width="600" />

4. Run test suites or individual tests using the play buttons

<img src="readme-images/e2e7.png" width="600" />

## WireMock

Some tests require WireMock to mock HTTP responses from LLM providers. To start it, trigger the `e2e-test-dependencies` resource in Tilt.

<img src="readme-images/e2e8.png" width="600" />

Then set the provider base URL env vars in your `.env`:
```
ARCHESTRA_OPENAI_BASE_URL=http://localhost:9092/openai/v1
ARCHESTRA_ANTHROPIC_BASE_URL=http://localhost:9092/anthropic
ARCHESTRA_GEMINI_BASE_URL=http://localhost:9092/gemini
ARCHESTRA_VLLM_BASE_URL=http://localhost:9092/vllm/v1
ARCHESTRA_OLLAMA_BASE_URL=http://localhost:9092/ollama/v1
ARCHESTRA_CEREBRAS_BASE_URL=http://localhost:9092/cerebras/v1
ARCHESTRA_ZHIPUAI_BASE_URL=http://localhost:9092/zhipuai/v4
ARCHESTRA_COHERE_BASE_URL=http://localhost:9092/cohere
ARCHESTRA_MISTRAL_BASE_URL=http://localhost:9092/mistral
ARCHESTRA_GROQ_BASE_URL=http://localhost:9092/groq/v1
ARCHESTRA_XAI_BASE_URL=http://localhost:9092/xai/v1
ARCHESTRA_OPENROUTER_BASE_URL=http://localhost:9092/openrouter/api/v1
```
