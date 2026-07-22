/**
 * Optimized test setup using PGlite with file-level database initialization.
 *
 * Performance Optimizations Applied:
 * 1. Database and migrations created ONCE per test file (beforeAll), not per test
 * 2. Tables are truncated between tests (beforeEach), much faster than recreating DB
 * 3. PGlite instance is reused across all tests in a file
 * 4. Sentry is disabled to prevent data transmission during tests
 *
 * Based on insights from:
 * - https://vitest.dev/guide/improving-performance
 * - https://github.com/drizzle-team/drizzle-orm/issues/4205
 * - https://dev.to/benjamindaniel/how-to-test-your-nodejs-postgres-app-using-drizzle-pglite-4fb3
 */

import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
// Dependency-free by design — safe to import before test files apply mocks.
import { clearRegisteredProcessLocalCaches } from "@/process-local-cache-registry";
import { getMigrationsSql, SNAPSHOT_PATH_ENV } from "./migrations-helper.js";

// Disable Sentry for tests - set BEFORE any config modules are loaded
process.env.ARCHESTRA_SENTRY_BACKEND_DSN = "";
process.env.ARCHESTRA_SENTRY_ENVIRONMENT = "test";
// Silence backend pino output during unit tests while preserving logger calls for spies/assertions.
process.env.ARCHESTRA_LOGGING_LEVEL = "silent";
// Enable enterprise white-labeling in backend tests so branding-aware helpers
// exercise the branded built-in MCP paths instead of the default prefix.
process.env.ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING = "true";
// PGlite-backed tests do not provide a session-stable pg.Client connection for
// LISTEN/NOTIFY, so use the polling compatibility notifier by default in tests.
process.env.ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED = "true";
// Pin "My Files" byte storage to the inline (db) provider for hermetic tests,
// independent of the dev .env. The filesystem-specific suites opt in by
// overriding config.fileStorage at runtime against a temp root.
process.env.ARCHESTRA_FILE_STORAGE_PROVIDER = "db";
process.env.ARCHESTRA_FILE_STORAGE_FILESYSTEM_ROOT = "";
// Vertex AI mode must not leak in from a developer's .env (config.ts loads it
// via dotenv, which never overrides values set here first): it flips the
// gemini client into the ADC construction path and makes default-LLM
// resolution prefer gemini over anthropic, breaking e.g. the gemini
// createClient baseUrl test and the chat prompt-cache-breakpoint tests.
process.env.ARCHESTRA_GEMINI_VERTEX_AI_ENABLED = "false";
process.env.ARCHESTRA_GEMINI_VERTEX_AI_PROJECT = "";
process.env.ARCHESTRA_GEMINI_VERTEX_AI_LOCATION = "";

// Set auth secret for tests
process.env.ARCHESTRA_AUTH_SECRET = "auth-secret-unit-tests-32-chars!";

// Vitest file workers can stack multiple process-level exit listeners during
// backend test setup/teardown; raise the cap slightly to avoid noisy warnings.
process.setMaxListeners(20);

// Module-level variables to persist across tests within a file
let pgliteClient: PGlite | null = null;
// Pristine config snapshot for the per-test restore (see beforeEach).
// Captured HERE at setup-module scope — setup files evaluate before any test
// file's module code in the worker, so a test file that mutates config (or
// installs accessors) during its own module evaluation can no longer poison
// the baseline the way a first-file beforeAll capture could.
let liveConfig: Record<string, unknown> | null = null;
let pristineConfig: Record<string, unknown> | null = null;
if (process.env.ARCHESTRA_TEST_SHARED_WORKERS === "true") {
  liveConfig = (await import("../config.js")).default as unknown as Record<
    string,
    unknown
  >;
  pristineConfig = structuredClone(liveConfig);
}
let testDb: ReturnType<typeof drizzle> | null = null;
const originalConsoleWarn = console.warn;

console.warn = (...args: unknown[]) => {
  const message = args.map(String).join(" ");

  if (
    message.includes(
      "[Better Auth]: Please ensure '/.well-known/oauth-authorization-server' exists",
    ) ||
    message.includes(
      "[Better Auth]: Please ensure '/.well-known/openid-configuration' exists",
    )
  ) {
    return;
  }

  originalConsoleWarn(...args);
};

/**
 * Initialize the database once per test file.
 *
 * Fast path: load the fully-migrated schema from the snapshot built once by
 * `global-setup.ts` (see SNAPSHOT_PATH_ENV) — a flat cost regardless of migration count.
 * Fallback: if no snapshot is available (e.g. a tooling path that skips globalSetup),
 * replay the migrations directly so the suite still works.
 */
beforeAll(async () => {
  const snapshotPath = process.env[SNAPSHOT_PATH_ENV];

  if (snapshotPath && fs.existsSync(snapshotPath)) {
    const snapshot = new Blob([fs.readFileSync(snapshotPath)]);
    pgliteClient = new PGlite({
      loadDataDir: snapshot,
      extensions: { vector },
    });
    testDb = drizzle({ client: pgliteClient });
  } else {
    pgliteClient = new PGlite("memory://", { extensions: { vector } });
    testDb = drizzle({ client: pgliteClient });
    for (const migrationSql of getMigrationsSql()) {
      await pgliteClient.exec(migrationSql);
    }
  }

  // Finish PGlite's async WASM init (incl. its browser-vs-node environment
  // detection) before any test code runs: tests that fake browser globals
  // (e.g. a `window` for the app SDK) would otherwise race the detection and
  // send PGlite down the browser path mid-init.
  await pgliteClient.waitReady;

  // Set the test database via the internal setter. The module's default
  // export is a forwarding Proxy over getDb(), so consumers — including
  // singletons constructed at import time, like better-auth's drizzle
  // adapter — always reach the CURRENT file's database. Do not replace the
  // default export with the concrete instance: in a shared worker
  // (isolate: false) that would pin import-time consumers to whichever
  // file's PGlite happened to be live, which is closed by the time later
  // files run ("PGlite is closed").
  const dbModule = await import("../database/index.js");
  dbModule.__setTestDb(
    testDb as unknown as Parameters<typeof dbModule.__setTestDb>[0],
  );
});

/**
 * Clean up tables before each test to ensure test isolation.
 * Using TRUNCATE CASCADE is the fastest way to clear all data.
 */
beforeEach(async () => {
  if (!pgliteClient) {
    throw new Error("Database not initialized. Did beforeAll run?");
  }

  // Restore the pristine config before every test. This hook is registered
  // before any test-file hooks, so a file's own beforeEach still applies its
  // config tweaks on top — but nothing a test mutated can leak into the next
  // test or, in shared workers, the next file.
  if (liveConfig && pristineConfig) {
    restoreConfig(liveConfig, structuredClone(pristineConfig));
  }

  // Get all user tables from the database (excluding system tables)
  const tablesResult = await pgliteClient.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE 'drizzle_%'
  `);

  const tables = tablesResult.rows.map((row) => row.tablename);

  if (tables.length > 0) {
    // Use TRUNCATE ... CASCADE for all tables at once
    // This is the fastest way to clear all data while respecting FK constraints
    const truncateSql = `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`;
    await pgliteClient.exec(truncateSql);
  }

  // Process-local caches (e.g. the agent id/slug resolve cache) outlive the
  // per-test truncation above — clear every registered one so a mapping cached
  // by one test (fixture slugs are name-derived and can repeat) can't leak
  // into the next. The registry module is dependency-free, so importing it
  // here cannot pre-load real modules ahead of a test file's mocks.
  clearRegisteredProcessLocalCaches();

  // NOTE: We intentionally do NOT seed organization or default agent here.
  // Tests that need them should use makeOrganization and makeAgent fixtures.
  // This allows organization tests to test both with and without existing organizations.
});

/**
 * Clear mocks after each test, and restore the real fetch and real timers.
 *
 * Several tests replace `globalThis.fetch` directly (not via vi.stubGlobal,
 * which `unstubGlobals` already handles). A mock left behind — e.g. when an
 * assertion throws before an inline restore — poisons every later file in
 * the worker. This hook is registered before any test-file hooks, so Vitest
 * runs it LAST in the afterEach sequence: it always gets the final word.
 *
 * Fake timers leak the same way: neither clearAllMocks nor unstubGlobals
 * undoes vi.useFakeTimers, and in a shared worker a leaked frozen clock
 * stalls every later setTimeout and makes DB timestamps collide across
 * unrelated files. useRealTimers is a no-op when timers are already real.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
  vi.useRealTimers();

  // Also restore the pristine config on the way OUT of every test. The
  // beforeEach restore alone leaves a gap: mutations made by a file's LAST
  // test survive until the NEXT file's first beforeEach — which is after
  // that file's beforeAll has already run. Route tests build their Fastify
  // server in beforeAll, so a leaked flag (a polling toggle, a feature flag,
  // ...) could shape another file's server for its entire lifetime.
  if (liveConfig && pristineConfig) {
    restoreConfig(liveConfig, structuredClone(pristineConfig));
  }
});

/**
 * Clean up the PGlite client after all tests in the file complete.
 *
 * Clearing the injected test DB matters in shared workers (isolate: false):
 * module-level consumers evaluated while the NEXT file loads — e.g.
 * better-auth's eager context init querying trusted IdP providers — would
 * otherwise reach this file's closed PGlite and surface as unhandled
 * "PGlite is closed" rejections. With the DB cleared they get getDb()'s
 * "Database not initialized", which those import-time paths already handle.
 */
afterAll(async () => {
  console.warn = originalConsoleWarn;

  // Drain fire-and-forget async work (e.g. interaction usage tracking) BEFORE
  // swapping out this file's database. In shared workers the getDb() proxy
  // always routes to the CURRENT file's PGlite, so a background promise that
  // outlives its file would run its remaining queries against the NEXT
  // file's database — interleaving with that file's tests or wedging its
  // connection mid-transaction (a batch of consecutive 30s timeouts).
  const { drainBackgroundWork } = await import("../utils/background-work.js");
  await drainBackgroundWork();

  const dbModule = await import("../database/index.js");
  dbModule.__setTestDb(null);

  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  testDb = null;
});

/**
 * Overwrite `live`'s contents with `snapshot`'s, in place (the config module
 * object is referenced everywhere, so identity must be preserved). Keys added
 * by a test are deleted; nested objects are restored recursively.
 */
function restoreConfig(
  live: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(live)) {
    if (!(key in snapshot)) {
      delete live[key];
    }
  }
  for (const [key, snapValue] of Object.entries(snapshot)) {
    const liveValue = live[key];
    if (
      snapValue !== null &&
      typeof snapValue === "object" &&
      !Array.isArray(snapValue) &&
      liveValue !== null &&
      typeof liveValue === "object" &&
      !Array.isArray(liveValue)
    ) {
      restoreConfig(
        liveValue as Record<string, unknown>,
        snapValue as Record<string, unknown>,
      );
    } else {
      // Skip accessor properties (getter-only config fields cannot be
      // assigned, and getter-based test doubles manage their own state).
      const descriptor = Object.getOwnPropertyDescriptor(live, key);
      if (descriptor && !("value" in descriptor)) continue;
      live[key] = snapValue;
    }
  }
}
