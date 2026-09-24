/**
 * Optimized test setup using PGlite with file-level database initialization.
 *
 * Performance Optimizations Applied:
 * 1. Database and migrations created ONCE per test file (beforeAll), not per test
 * 2. Tables are truncated after tests that accessed the DB; pure tests skip it
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
// Native/OpenAPPA tests opt in explicitly; local policy settings must not
// switch unrelated PGlite suites away from the existing guardrails.
process.env.ARCHESTRA_LLM_PROXY_PLUGINS = "";
process.env.ARCHESTRA_OPENAPPA_ENABLED = "false";

// Set auth secret for tests
process.env.ARCHESTRA_AUTH_SECRET = "auth-secret-unit-tests-32-chars!";

// Vitest file workers can stack multiple process-level exit listeners during
// backend test setup/teardown; raise the cap slightly to avoid noisy warnings.
process.setMaxListeners(20);

// Module-level variables to persist across tests within a file
let pgliteClient: PGlite | null = null;
// Tests that never issue SQL leave the database unchanged, so the next test
// can skip truncating hundreds of tables.
let databaseTouched = false;
// The rollback project opts in explicitly; all ordinary database tests keep
// the table reset, including tests of commit and schema-change behavior.
const rollbackMode = process.env.ARCHESTRA_TEST_SHARED_WORKERS === "rollback";
let completedRollbackTests = 0;
let releaseTestTransaction: (() => void) | null = null;
let testTransactionFinished: Promise<void> | null = null;
const rollbackSentinel = new Error("Test transaction rollback");
// Pristine config snapshot for the per-test restore (see beforeEach).
// Captured HERE at setup-module scope — setup files evaluate before any test
// file's module code in the worker, so a test file that mutates config (or
// installs accessors) during its own module evaluation can no longer poison
// the baseline the way a first-file beforeAll capture could.
let liveConfig: Record<string, unknown> | null = null;
let pristineConfig: Record<string, unknown> | null = null;
// enterpriseTier is a module-level singleton whose userCount is shared across
// every clean-project file in an isolate:false worker. Nothing resets it
// between tests (unlike config), so a file that bumps it via
// setUserCountForTesting leaks its enterprise gate into later files. Captured
// via deferred import for the same reason as config: a static top-level import
// would pull config.ts before the env above is set.
type EnterpriseTierRef = typeof import("../enterprise-tier.js").enterpriseTier;
let enterpriseTier: EnterpriseTierRef | null = null;
if (process.env.ARCHESTRA_TEST_SHARED_WORKERS === "true" || rollbackMode) {
  liveConfig = (await import("../config.js")).default as unknown as Record<
    string,
    unknown
  >;
  pristineConfig = structuredClone(liveConfig);
  enterpriseTier = (await import("../enterprise-tier.js")).enterpriseTier;
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
  completedRollbackTests = 0;
  const snapshotPath = process.env[SNAPSHOT_PATH_ENV];

  if (snapshotPath && fs.existsSync(snapshotPath)) {
    const snapshot = new Blob([fs.readFileSync(snapshotPath)]);
    pgliteClient = new PGlite({
      loadDataDir: snapshot,
      extensions: { vector },
    });
  } else {
    pgliteClient = new PGlite("memory://", { extensions: { vector } });
    for (const migrationSql of getMigrationsSql()) {
      await pgliteClient.exec(migrationSql);
    }
  }

  // Finish PGlite's async WASM init (incl. its browser-vs-node environment
  // detection) before any test code runs: tests that fake browser globals
  // (e.g. a `window` for the app SDK) would otherwise race the detection and
  // send PGlite down the browser path mid-init.
  await pgliteClient.waitReady;
  trackDatabaseAccess(pgliteClient);
  testDb = drizzle({ client: pgliteClient });

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
  // Preserve the existing first-test reset: migrations may leave seed rows in
  // the snapshot, and a file-level hook may access the database before tests.
  databaseTouched = true;
});

/** Reset the database only after a test (or file-level hook) accessed it. */
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

  // Reset the enterpriseTier singleton to userCount 0 (small-team => enterprise
  // active), its pristine default. Nothing else clears it between tests, so a
  // userCount another clean file left at 9999 would flip the enterprise gate
  // off here; shuffle makes which test loses the race random => flaky. The gate
  // is read at request time, so a beforeEach reset closes the whole window.
  if (enterpriseTier) {
    enterpriseTier.setUserCountForTesting(0);
  }

  if (databaseTouched && (!rollbackMode || completedRollbackTests === 0)) {
    // Get all user tables from the database (excluding system tables)
    const tablesResult = await pgliteClient.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename NOT LIKE 'drizzle_%'
    `);

    const tables = tablesResult.rows.map((row) => row.tablename);

    if (tables.length > 0) {
      // CASCADE also clears dependent tables, and RESTART IDENTITY resets
      // sequences used by fixtures.
      const truncateSql = `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`;
      await pgliteClient.exec(truncateSql);
    }
  }
  databaseTouched = false;

  // Process-local caches (e.g. the agent id/slug resolve cache) outlive the
  // database reset above — clear every registered one so a mapping cached
  // by one test (fixture slugs are name-derived and can repeat) can't leak
  // into the next. The registry module is dependency-free, so importing it
  // here cannot pre-load real modules ahead of a test file's mocks.
  clearRegisteredProcessLocalCaches();

  if (rollbackMode) {
    if (!testDb) throw new Error("Test database not initialized");
    let signalReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseTestTransaction = release;
    let started = false;
    testTransactionFinished = testDb
      .transaction(async (tx) => {
        const dbModule = await import("../database/index.js");
        dbModule.__setTestDb(
          tx as unknown as Parameters<typeof dbModule.__setTestDb>[0],
        );
        started = true;
        signalReady();
        await hold;
        throw rollbackSentinel;
      })
      .catch((error: unknown) => {
        signalReady();
        if (error !== rollbackSentinel) throw error;
      });
    await ready;
    if (!started) await testTransactionFinished;
  }

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
  if (rollbackMode) {
    return finishTestTransaction().finally(restoreTestGlobals);
  }
  restoreTestGlobals();
});

async function finishTestTransaction(): Promise<void> {
  // Registered fire-and-forget work must finish while its test's transaction
  // is still open. The ordinary project continues to drain at file teardown.
  const errors: unknown[] = [];
  const release = releaseTestTransaction;
  const finished = testTransactionFinished;
  try {
    const { drainBackgroundWork } = await import("../utils/background-work.js");
    await drainBackgroundWork();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      release?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await finished;
    } catch (error) {
      errors.push(error);
    }
    try {
      const dbModule = await import("../database/index.js");
      dbModule.__setTestDb(
        testDb as unknown as Parameters<typeof dbModule.__setTestDb>[0],
      );
    } catch (error) {
      errors.push(error);
    } finally {
      releaseTestTransaction = null;
      testTransactionFinished = null;
      // An unsuccessful teardown makes the next test rebuild the clean state.
      completedRollbackTests =
        errors.length === 0 ? completedRollbackTests + 1 : 0;
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}

function restoreTestGlobals(): void {
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
}

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
  databaseTouched = false;
});

function trackDatabaseAccess(client: PGlite): void {
  // Patch the prototype rather than shadowing instance methods: tests can spy
  // on PGlite.prototype.query. Drizzle transactions use a separate client, so
  // entering any transaction must count as access as well. Count reads too:
  // an extra reset is safer than inferring which SQL writes.
  const sqlPrototype = PGlite.prototype as unknown as {
    [databaseAccessTrackersKey]?: WeakMap<PGlite, () => void>;
    query: (...args: unknown[]) => Promise<unknown>;
    exec: (...args: unknown[]) => Promise<unknown>;
    transaction: (...args: unknown[]) => Promise<unknown>;
  };
  if (!sqlPrototype[databaseAccessTrackersKey]) {
    const trackers = new WeakMap<PGlite, () => void>();
    const query = sqlPrototype.query;
    const exec = sqlPrototype.exec;
    const transaction = sqlPrototype.transaction;
    sqlPrototype.query = function (this: PGlite, ...args: unknown[]) {
      trackers.get(this)?.();
      return Reflect.apply(query, this, args);
    };
    sqlPrototype.exec = function (this: PGlite, ...args: unknown[]) {
      trackers.get(this)?.();
      return Reflect.apply(exec, this, args);
    };
    sqlPrototype.transaction = function (this: PGlite, ...args: unknown[]) {
      trackers.get(this)?.();
      return Reflect.apply(transaction, this, args);
    };
    sqlPrototype[databaseAccessTrackersKey] = trackers;
  }
  sqlPrototype[databaseAccessTrackersKey].set(client, () => {
    databaseTouched = true;
  });
}

const databaseAccessTrackersKey = Symbol.for(
  "archestra.test.pgliteAccessTrackers",
);

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
