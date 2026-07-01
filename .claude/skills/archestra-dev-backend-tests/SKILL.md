---
name: archestra-dev-backend-tests
description: Use when writing or modifying Archestra backend unit tests (platform/backend/src/**/*.test.ts) — mocking modules, stubbing globals, database fixtures, vitest projects/isolation, or test performance.
---

# Archestra Backend Unit Tests

Run commands from `platform/` unless specifically instructed otherwise. Run a single file with `cd backend && npx vitest run <file>`.

## The two vitest projects (why mocking style matters)

`backend/vitest.config.ts` splits test files into two projects at config-load time by grepping file content:

- **`clean`** — files with NO `vi.mock`/`vi.doMock`/`vi.hoisted` run with `isolate: false`: worker threads share the module cache, so the backend module graph is imported once per worker instead of once per file. This is the fast path.
- **`mocked`** — files using module mocking keep full isolation, because Vitest never resets the module-mock registry between files in a shared worker (vitest-dev/vitest#4894).

Consequences:

- **Prefer not mocking modules at all.** Every file that drops its last `vi.mock` automatically joins the fast project. Mock at the process boundary instead (fetch, network) when possible.
- Routing is automatic — never maintain a file list; adding `vi.mock` to a file safely moves it to the isolated project on the next run.

## Module mocking rules

- **`@/auth`**: activate with a bare `vi.mock("@/auth");` — Vitest resolves the Jest-style `src/auth/__mocks__/index.ts`, which re-exports the canonical factory (`src/test/mocks/auth.ts`: every export a bare `vi.fn()`). Configure behavior per test via `vi.mocked(...)`:

  ```ts
  vi.mock("@/auth");
  import { hasPermission } from "@/auth";
  beforeEach(() => {
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
  });
  ```

- **`@/logging`**: do NOT mock just to silence output — the shared setup already runs the real logger at level `silent`. Only mock when a test asserts on logger calls, with a bare `vi.mock("@/logging");` (resolves `src/logging/__mocks__/index.ts`). `vi.spyOn(logger, ...)` does not work — the export is a Proxy binding methods to a private pino instance.
- **`@/config`**: use the canonical deep-merge factory so unspecified keys keep their real values:

  ```ts
  vi.mock("@/config", async () =>
    (await import("@/test/mocks/config")).configModuleMock({
      kb: { taskWorkerPollIntervalSeconds: 1 },
    }),
  );
  ```

  Never hand-roll a partial `{ default: { kb: {...} } }` — it silently drops the rest of the config.
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

- Never mock `@/database` or model modules for DB behavior — every file gets a real PGlite loaded from a pre-migrated snapshot (`src/test/global-setup.ts` + `src/test/setup.ts`); tables are truncated between tests.
- Create data through fixtures from `@/test` (`makeUser`, `makeOrganization`, `makeAgent`, ...) — see the Backend Test Fixtures section in platform/CLAUDE.md.
- On file teardown the injected DB is cleared: module-level code that runs between files gets getDb()'s "Database not initialized" (a handled condition), never a closed PGlite.

## Performance etiquette

- The suite's budget is module-import cost. Heavy new top-level imports in widely-imported modules cost every worker; test-only helpers belong under `src/test/`.
- Local full-suite runs cap workers at cores−2 (config) so the machine stays usable; CI runs 4 shards via `vitest run --shard=k/4` behind the `Backend Unit Tests` gate job.
