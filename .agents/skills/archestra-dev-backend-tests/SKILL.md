---
name: archestra-dev-backend-tests
description: Use when writing or modifying Archestra backend unit tests (platform/backend/src/**/*.test.ts) — mocking modules, stubbing globals, database fixtures, vitest projects/isolation, or test performance.
---

# Archestra Backend Unit Tests

Run commands from `platform/` unless specifically instructed otherwise. Run a single file with `pnpm --dir backend exec vitest run <file>`.

## Test projects and database opt-in

Use `*.unit.test.ts` only for tests whose runtime import graph is database-free. These files run without PGlite setup or the migrated database snapshot. Import assertions and lifecycle functions directly from `vitest`; do not import `@/test`, application config, database fixtures, models, or the server entry point. Keep the code under test free of those runtime imports too. `pnpm --dir backend check:test-imports` checks this transitive boundary with dependency-cruiser. Type-only imports from permitted modules are fine because they do not load code at runtime; Biome still rejects direct imports from forbidden paths. If moving an existing test to this project reveals a config import, leave it database-backed until the pure logic is separated from config access.

Use ordinary `*.test.ts` for tests that need real database behavior, fixtures, or route integration. They opt into the PGlite setup and migrated snapshot. Never rename a database-backed test to `*.unit.test.ts` merely to make it run faster.

Within each group, `backend/vitest.config.ts` splits files by module mocking at config-load time:

- **`clean` / `unit`** — files with NO `vi.mock`/`vi.doMock`/`vi.hoisted` run with `isolate: false`: files in the same worker process share the module cache. This is the fast path.
- **`mocked` / `unit-mocked`** — files using module mocking keep full isolation, because Vitest never resets the module-mock registry between files in a shared worker (vitest-dev/vitest#4894).

Consequences:

- **Prefer not mocking modules at all.** Every file that drops its last `vi.mock` automatically joins the fast project. Mock at the process boundary instead (fetch, network) when possible.
- Database selection follows the explicit filename suffix; mock isolation is automatic. Adding `vi.mock` to a file safely moves it to the isolated project on the next run.
- Route tests import `createFastifyInstance` and `FastifyInstanceWithZod` from `@/fastify-instance`, and `useRouteTestApp` from `@/test/route-test-app`. Do not import `@/server` in tests or re-export the route helper from the general `@/test` barrel; both load the server startup graph into unrelated tests.

## HTTP boundary mocking (instead of vi.mock on client libraries)

Never `vi.mock` an HTTP client library (`jira.js`, `@gitbeaker/rest`, `openai`, ...). Use MSW via the `useMswServer` helper — the real client runs and only the network is faked (MSW intercepts axios, fetch, and undici alike):

```ts
import { http, HttpResponse } from "msw";
import { useMswServer } from "@/test/msw";

const server = useMswServer();
test("...", async () => {
  server.use(
    http.get("https://example.atlassian.net/rest/api/3/search/jql", () =>
      HttpResponse.json({ issues: [] }),
    ),
  );
});
```

Unhandled requests fail the test loudly. The helper's lifecycle is per test (it must be — the shared setup restores `globalThis.fetch` after every test); don't hand-roll `setupServer` with `beforeAll` listen.

Wire-level gotchas learned in past conversions: clients retry — gitbeaker retries 429/502 up to 10× with backoff and openai retries 429/5xx (choose a status that the specific client does not retry, or configure/account for its retries; OpenAI retries 500); MSW 2.x route paths use path-to-regexp 8, which rejects RegExp paths and bare `*` — use `:param` segments (URL-encoded slashes like `%2F` stay one segment and decode in the param).

## Module mocking rules

- **`@/auth`**: activate with a bare `vi.mock("@/auth");` — Vitest resolves the Jest-style `src/auth/__mocks__/index.ts`, which re-exports the canonical factory (`src/test/mocks/auth.ts`: every export a bare `vi.fn()`). Configure behavior per test via `vi.mocked(...)`:

  ```ts
  vi.mock("@/auth");
  import { hasPermission } from "@/auth";
  beforeEach(() => {
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
  });
  ```

- **`@/auth/utils`**: bare `vi.mock("@/auth/utils");` (resolves `src/auth/__mocks__/utils.ts`). Needed separately from `@/auth` when the code under test imports from "@/auth/utils" directly — module mocks match specifiers, not re-exports.
- **`@/observability`**: bare `vi.mock("@/observability");` (resolves `src/observability/__mocks__/index.ts`). `metrics`/`tracing` are memoized proxy trees — any `metrics.<ns>.<fn>` access yields a stable `vi.fn()`, so assert via `vi.mocked(metrics.llm.someFn)` with no factory.
- **`@/cache-manager`**: bare `vi.mock("@/cache-manager");` (resolves `src/__mocks__/cache-manager.ts`) — a Map-backed `cacheManager` fake with real cache semantics that needs no `start()`, auto-reset before every test; `CacheKey` and `LRUCacheManager` stay real. Tests needing a cache MISS mid-test call `await cacheManager.delete(key)`.
- **`@/logging`**: do NOT mock just to silence output — the shared setup already runs the real logger at level `silent`. Only mock when a test asserts on logger calls, with a bare `vi.mock("@/logging");` (resolves `src/logging/__mocks__/index.ts`). `vi.spyOn(logger, ...)` does not work — the export is a Proxy binding methods to a private pino instance.
- **`@/config`**: use the canonical deep-merge factory so unspecified keys keep their real values:

  ```ts
  vi.mock("@/config", async () =>
    (await import("@/test/mocks/config")).configModuleMock({
      kb: { taskWorkerPollIntervalSeconds: 1 },
    }),
  );
  ```

  Never hand-roll a partial `{ default: { kb: {...} } }` — it silently drops the rest of the config. And prefer no config mock at all: direct mutation (next bullet) keeps the file in the fast project; the factory is only NEEDED when the code under test reads config at module-import time (module-level `const` captures), which a runtime mutation can't reach.
- **Mutating the real config** (`config.skillsSandbox.enabled = true` style, common in clean-project files): set it in `beforeEach` or inside the test, NOT in `beforeAll` or at module scope — the shared setup restores the pristine config before AND after every test in the shared-worker project, so a once-per-file mutation evaporates after the first test. No manual restore needed.
- **Fire-and-forget async DB work in product code** (a promise launched without `await`, like `InteractionModel.create`'s usage-tracking update) must be registered with `trackBackgroundWork` from `@/utils/background-work` — the shared teardown drains the registry before swapping out the file's PGlite. An untracked background promise that outlives its file runs its remaining queries against the NEXT file's database and can wedge it (a batch of consecutive 30s timeouts).
- **Never write a bespoke partial factory** for a module that has a canonical mock, and **never mix a bare `vi.mock("x")` with a factory `vi.mock("x", ...)` for the same specifier across files** — Vitest can silently skip one depending on execution order (vitest-dev/vitest#10145).
- Mock typing is real: `vi.mocked(fn)` carries the actual signature. If the compiler rejects your mock's resolved value, the OLD untyped mock was probably wrong (e.g. resolving a truthy object where the code expects a boolean).

## Global stubs (fetch, window, env)

The config sets `unstubGlobals: true` / `unstubEnvs: true`: every `vi.stubGlobal`/`vi.stubEnv` is auto-reverted after EACH test.

- **Stub in `beforeEach`, never only at module scope or in `beforeAll`** — a module-scope stub is silently removed after the first test:

  ```ts
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock); // covers import time
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock); // re-applied per test
  });
  ```

- **Never raw-assign `globalThis.fetch = ...`** — use `vi.stubGlobal`. (The shared setup restores the real fetch after every test as a safety net, so a raw assignment doesn't survive anyway.)
- Faking browser globals (`window`, `location`) confuses PGlite's environment detection; the shared setup finishes PGlite init before test code runs, but always clean such globals up in `afterAll`.

## Database

- Never mock `@/database` or model modules for DB behavior — database-backed files get a real PGlite loaded from a pre-migrated snapshot (`src/test/global-setup.ts` + `src/test/setup.ts`). The setup truncates tables before the first test and after any test that accessed the database. Pure tests skip the expensive truncate, and `*.unit.test.ts` files have no PGlite setup.
- Create data through fixtures from `@/test` (`makeUser`, `makeOrganization`, `makeAgent`, ...) — see the Backend Test Fixtures section in platform/AGENTS.md.
- To share a test object, pass `access` to its fixture (`makeAgent`, `makeSkill`, `makeApp`, `makeInternalMcpCatalog`, `makeLlmProviderApiKey`, `makeVirtualApiKey`, `makeKnowledgeBase`, `makeKnowledgeBaseConnector`). `access` is `"personal"` (author only), `"org"` (the audience the system create path gives), `{ teams, level: "use" | "edit" }` (a team may also be `{ id, level }`) or `{ users, preset: "view" | "use" | "edit" | "manage" }`. Defaults differ per fixture: agents, apps, catalog items and virtual keys default to `"org"`; skills to the author; a provider key to its owner when `userId` is set, else `"org"`; knowledge bases and connectors without `access` are inserted with no policy. The fixture writes grants through the production create path (`ResourcePermissionPolicyModel.createInitial`). Do not insert grants by hand. The fixtures do not take the retired `scope`/`teams`/`visibility` fields. For a test that calls a model create method itself, spread `accessGrants(access)` from `@/test` into its options. The helper is in `backend/src/test/access-grants.ts`.
- Only tests of code that still reads the retired sharing columns or team rows (the upgrade cutover, the `agent_team` readers) seed them, through the fixtures' `legacy` option (`{ scope, teams }` on agents, apps and catalog items; `{ visibility, teamIds }` on knowledge bases and connectors). It writes the columns and team rows and never changes grants. See `backend/src/test/legacy-sharing.ts`.
- On file teardown the injected DB is cleared: module-level code that runs between files gets getDb()'s "Database not initialized" (a handled condition), never a closed PGlite.

## Performance etiquette

- The suite's budget is module-import cost. Heavy new top-level imports in widely-imported modules cost every worker; test-only helpers belong under `src/test/`.
- Local full-suite runs cap workers at half the cores (config) so the machine stays usable, further bounded by a ~5 GB-per-fork memory cap; CI uses all cores under the same memory cap and runs 8 shards via `vitest run --shard=k/8` behind the `Backend Unit Tests` gate job.
