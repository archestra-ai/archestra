/**
 * Optimized test setup using PGlite with file-level database initialization.
 *
 * Performance Optimizations Applied:
 * 1. Database loaded from an empty, pre-migrated snapshot at most ONCE per test
 *    file, on its first access; files that never touch it skip the load
 * 2. Tables are truncated after tests that accessed the DB; pure tests skip it
 * 3. PGlite instance is reused across all tests in a file
 * 4. Sentry is disabled to prevent data transmission during tests
 *
 * Based on insights from:
 * - https://vitest.dev/guide/improving-performance
 * - https://github.com/drizzle-team/drizzle-orm/issues/4205
 * - https://dev.to/benjamindaniel/how-to-test-your-nodejs-postgres-app-using-drizzle-pglite-4fb3
 */

// Dependency-free; restores the globals an earlier file in this worker left
// replaced before any other module captures them.
import { pristineFetch } from "./worker-globals";
// Filters Better Auth noise once per worker; see why it must not be per file.
import "./quiet-console";
// Binds the ports of the layers below before any other module loads.
import "@/server/composition";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { assertPortsBound } from "@/models/ports";
// Dependency-free by design — safe to import before test files apply mocks.
import { clearRegisteredProcessLocalCaches } from "@/process-local-cache-registry";
import { onDatabaseAccess } from "./database-access";
import { getMigrationsSql, SNAPSHOT_PATH_ENV } from "./migrations-helper.js";

// The composition module, imported first, bound the ports of the layers
// below; stop here if one is unbound.
assertPortsBound();

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
// Keep unrelated beta features off even when a developer's .env enables them.
// OpenAPPA is always available; enforcement tests opt in through the deployment
// Guardrails setting. A test of another beta feature stubs its own gate.
process.env.ARCHESTRA_BETA = "false";
process.env.ARCHESTRA_LLM_PROXY_PLUGINS = "";

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
// The filename opts a suite into rollback; ordinary database suites retain
// table resets, including tests of commit and schema-change behavior.
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
// archestraMcpBranding is the same kind of singleton: a test that syncs the
// built-in catalog for a white-labeled organization leaves the tool prefix
// branded (`acme_copilot__` instead of `archestra__`) for every later test in
// the worker, and the next file in the worker then names its OpenAPPA tools
// after that organization. Reset it with config, on the way in and out.
type ArchestraMcpBrandingRef =
  typeof import("../archestra-mcp-server/branding.js").archestraMcpBranding;
let archestraMcpBranding: ArchestraMcpBrandingRef | null = null;
if (process.env.ARCHESTRA_TEST_SHARED_WORKERS === "true") {
  liveConfig = (await import("../config.js")).default as unknown as Record<
    string,
    unknown
  >;
  pristineConfig = structuredClone(liveConfig);
  enterpriseTier = (await import("../enterprise-tier.js")).enterpriseTier;
  archestraMcpBranding = (await import("../archestra-mcp-server/branding.js"))
    .archestraMcpBranding;
}
type TestDatabase = ReturnType<typeof drizzle>;
let testDb: TestDatabase | null = null;
// Snapshot this file loads on its first database access (see beforeAll).
let pendingSnapshotPath: string | null = null;
// Installed as the app database for the whole file; forwarding through it
// defers loading PGlite until code actually reaches the database.
const lazyTestDb = new Proxy({} as TestDatabase, {
  get(_, prop) {
    return Reflect.get(getTestDatabase(), prop);
  },
}) as unknown as Parameters<
  typeof import("../database/index.js").__setTestDb
>[0];
/**
 * Install this file's database, created lazily on first access.
 *
 * Fast path: the fully-migrated, row-free schema snapshot built once by
 * `global-setup.ts` (see SNAPSHOT_PATH_ENV) loads the first time the file
 * reaches the database — a flat cost regardless of migration count, and none
 * at all for files in these projects that never issue SQL. The snapshot is
 * created empty, so a freshly loaded database needs no reset.
 *
 * Loading takes real I/O, not just microtasks. A file that fakes timers
 * therefore loads eagerly: a test advancing fake time across a first database
 * access would otherwise finish advancing before the query resolves, leaving
 * the code under test parked on a fake timer nobody advances. A file whose
 * tests fake browser globals (e.g. a `window`) must reach the database before
 * installing them, since PGlite detects its environment during that load.
 *
 * Fallback: if no snapshot is available (e.g. a tooling path that skips
 * globalSetup), replay the migrations eagerly so the suite still works.
 */
// biome-ignore lint/correctness/noEmptyPattern: Vitest requires a destructured context before the suite argument.
beforeAll(async ({}, suite) => {
  completedRollbackTests = 0;
  databaseTouched = false;
  const snapshotPath = process.env[SNAPSHOT_PATH_ENV];
  pendingSnapshotPath =
    snapshotPath && fs.existsSync(snapshotPath) ? snapshotPath : null;

  if (!pendingSnapshotPath) {
    const client = new PGlite("memory://", { extensions: { vector } });
    for (const migrationSql of getMigrationsSql()) {
      await client.exec(migrationSql);
    }
    installDatabase(client);
    // Migrations may seed rows; reset them before the first test.
    databaseTouched = true;
  } else {
    const filepath = "filepath" in suite ? suite.filepath : suite.file.filepath;
    if (fs.readFileSync(filepath, "utf-8").includes("useFakeTimers")) {
      await getTestDatabase().$client.waitReady;
    }
  }

  // Set the test database via the internal setter. The module's default
  // export is a forwarding Proxy over getDb(), so consumers — including
  // singletons constructed at import time, like better-auth's drizzle
  // adapter — always reach the CURRENT file's database. Do not replace the
  // default export with the concrete instance: in a shared worker
  // (isolate: false) that would pin import-time consumers to whichever
  // file's PGlite happened to be live, which is closed by the time later
  // files run ("PGlite is closed"). A file-level hook that reaches the
  // database marks it touched, so the first test still starts empty.
  const dbModule = await import("../database/index.js");
  dbModule.__setTestDb(lazyTestDb);
});

/** Reset the database only after a test (or file-level hook) accessed it. */
beforeEach(async ({ task }) => {
  // Vitest exposes the current file on its typed hook context. This keeps
  // rollback suites in the clean project's shared module cache without
  // relying on process-global mode or internal runner state.
  const rollbackMode = task.file.filepath.endsWith(".rollback.test.ts");

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

  // Same for the MCP branding singleton: back to the unbranded default, so a
  // white-label test earlier in the worker cannot rename this test's tools.
  archestraMcpBranding?.syncFromOrganization(null);

  // Agent Runtime availability is detected from whatever cluster the default
  // kubeconfig points at, so a developer machine with the Agent Sandbox
  // controller would answer differently from CI. Default to "not installed";
  // a test that needs it either overrides this spy or restores it to exercise
  // real detection. Imported here, after the test file's mocks are applied.
  const { agentSandboxApi } = await import(
    "../k8s/agent-runtime/sandbox-api.js"
  );
  agentSandboxApi.reset();
  vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(false);

  if (
    pgliteClient &&
    databaseTouched &&
    (!rollbackMode || completedRollbackTests === 0)
  ) {
    await resetDatabase(pgliteClient);
  }
  databaseTouched = false;

  // Process-local caches (e.g. the agent id/slug resolve cache) outlive the
  // database reset above — clear every registered one so a mapping cached
  // by one test (fixture slugs are name-derived and can repeat) can't leak
  // into the next. The registry module is dependency-free, so importing it
  // here cannot pre-load real modules ahead of a test file's mocks.
  clearRegisteredProcessLocalCaches();

  if (rollbackMode) {
    const rootDb = getTestDatabase();
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
    testTransactionFinished = rootDb
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
 * The fetch restored here is the worker's original (see worker-globals.ts),
 * not whatever this file inherited.
 */
afterEach(({ task }) => {
  const rollbackMode = task.file.filepath.endsWith(".rollback.test.ts");
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
      dbModule.__setTestDb(lazyTestDb);
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
  globalThis.fetch = pristineFetch;
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
  archestraMcpBranding?.syncFromOrganization(null);
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
    const client = pgliteClient;
    pgliteClient = null;
    if (!(await keepDatabaseForNextFile(client))) await client.close();
  }
  testDb = null;
  pendingSnapshotPath = null;
  databaseTouched = false;
});

/**
 * Return this file's database, loading the migrated snapshot on first use.
 *
 * Construction is synchronous; PGlite queues queries until its async
 * initialization finishes, so callers need not await readiness.
 */
function getTestDatabase(): TestDatabase {
  if (testDb) return testDb;
  if (!pendingSnapshotPath) {
    throw new Error("Database not initialized. Did beforeAll run?");
  }
  const kept = takeKeptDatabase(pendingSnapshotPath);
  if (kept) return installDatabase(kept);
  const snapshot = new Blob([fs.readFileSync(pendingSnapshotPath)]);
  const client = new PGlite({ loadDataDir: snapshot, extensions: { vector } });
  if (process.env.ARCHESTRA_TEST_SHARED_WORKERS === "true") {
    // Queued ahead of the test's first query, so it reads the snapshot's
    // schema and session state before the test can change them.
    loadedStates.set(client, databaseState(client));
  }
  return installDatabase(client);
}

/**
 * In a shared worker, hand this file's database to the next file instead of
 * closing it: loading the migrated snapshot cost about 0.8 s per file. It is
 * kept only when it is back in the state a fresh load gives: tables and
 * sequences reset, and the schema and session state (settings, temporary
 * tables, listeners, advisory locks, prepared statements) unchanged since it
 * was loaded. A file that changes either makes the next file load the
 * snapshot again.
 */
async function keepDatabaseForNextFile(client: PGlite): Promise<boolean> {
  const store = globalThis as { [KEPT_DATABASE]?: KeptDatabase };
  delete store[KEPT_DATABASE];
  const loadedState = loadedStates.get(client);
  if (!loadedState || !pendingSnapshotPath || client.closed) return false;
  try {
    const loaded = await loadedState;
    // now() is the transaction's start, so it differs from the statement's
    // only inside a transaction a test left open.
    const open = await client.query<{ open: boolean }>(
      "SELECT now() <> statement_timestamp() AS open",
    );
    if (open.rows[0]?.open !== false) return false;
    // Session state is compared rather than discarded: DISCARD ALL would
    // drop the temporary tables the snapshot's migrations left in its
    // session, which PGlite cannot recover from ("cannot open relation").
    await resetDatabase(client);
    // PGlite keeps its write-ahead log in memory and checkpoints on its own
    // only at max_wal_size (1 GB), so a database kept across files would
    // hold up to that much log. A checkpoint after each file (~5 ms) keeps it
    // at about 100 MB.
    await client.exec("CHECKPOINT");
    if ((await databaseState(client)) !== loaded) {
      return false;
    }
  } catch {
    return false;
  }
  store[KEPT_DATABASE] = { client, snapshotPath: pendingSnapshotPath };
  return true;
}

function takeKeptDatabase(snapshotPath: string): PGlite | null {
  const store = globalThis as { [KEPT_DATABASE]?: KeptDatabase };
  const kept = store[KEPT_DATABASE];
  delete store[KEPT_DATABASE];
  if (!kept) return null;
  if (kept.snapshotPath !== snapshotPath || kept.client.closed) {
    void kept.client.close().catch(() => {});
    return null;
  }
  return kept.client;
}

/**
 * A fingerprint of the public schema (tables, columns, constraints, indexes,
 * routines, triggers, enums, extensions) and of the session's state, to tell
 * whether a file changed either.
 */
async function databaseState(client: PGlite): Promise<string> {
  const session = await client.query<{ state: string }>(`
    SELECT concat_ws('|',
      (SELECT string_agg(name || '=' || setting, ';' ORDER BY name)
        FROM pg_settings WHERE source = 'session'),
      (SELECT string_agg(relname, ';' ORDER BY relname)
        FROM pg_class WHERE relpersistence = 't'),
      (SELECT string_agg(channel, ';' ORDER BY channel)
        FROM pg_listening_channels() AS channel),
      (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'),
      (SELECT count(*) FROM pg_prepared_statements),
      (SELECT count(*) FROM pg_cursors)
    ) AS state
  `);
  const result = await client.query<{ fingerprint: string }>(`
    SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(',', c.relname, c.relkind, a.attname,
          a.atttypid, a.atttypmod, a.attnotnull, a.attnum,
          pg_get_expr(d.adbin, d.adrelid)), ';'
          ORDER BY c.relname, a.attnum)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attribute a
          ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = 'public'),
      (SELECT string_agg(pg_get_constraintdef(oid) || conname, ';' ORDER BY conname, oid::regclass::text)
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace),
      (SELECT string_agg(indexdef, ';' ORDER BY indexname)
        FROM pg_indexes WHERE schemaname = 'public'),
      (SELECT string_agg(p.proname || pg_get_function_identity_arguments(p.oid) || md5(p.prosrc), ';' ORDER BY p.proname, p.oid)
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
      (SELECT string_agg(tgname || tgrelid::regclass::text, ';' ORDER BY tgname, tgrelid::regclass::text)
        FROM pg_trigger WHERE NOT tgisinternal),
      (SELECT string_agg(enumtypid::regtype::text || enumlabel, ';' ORDER BY enumtypid::regtype::text, enumsortorder)
        FROM pg_enum),
      (SELECT string_agg(extname || extversion, ';' ORDER BY extname)
        FROM pg_extension)
    )) AS fingerprint
  `);
  return `${result.rows[0]?.fingerprint ?? ""}:${session.rows[0]?.state ?? ""}`;
}

/**
 * Put the database back to the empty, freshly migrated state: every table
 * empty and every table-owned sequence at its start, as truncating every
 * table with RESTART IDENTITY did. That TRUNCATE of 260-odd tables cost
 * 130-200 ms before every test that touched the database; a test leaves rows
 * in a handful of them, so only those are truncated (CASCADE takes the
 * tables that reference them too), then the sequences a test used without
 * leaving rows, such as by a failed insert, are restarted.
 */
async function resetDatabase(client: PGlite): Promise<void> {
  const tables = await client.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE 'drizzle_%'
  `);
  if (tables.rows.length === 0) return;
  const withRows = await client.query<{ tablename: string }>(
    tables.rows
      .map(
        ({ tablename }) =>
          `SELECT ${quoteLiteral(tablename)} AS tablename WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(tablename)})`,
      )
      .join(" UNION ALL "),
  );
  if (withRows.rows.length > 0) {
    await client.exec(
      `TRUNCATE TABLE ${withRows.rows.map(({ tablename }) => quoteIdentifier(tablename)).join(", ")} RESTART IDENTITY CASCADE`,
    );
  }
  const usedSequences = await client.query<{ sequence: string }>(`
    SELECT DISTINCT dependency.objid::regclass::text AS sequence
    FROM pg_depend dependency
    JOIN pg_class sequence_class
      ON sequence_class.oid = dependency.objid AND sequence_class.relkind = 'S'
    JOIN pg_class owner ON owner.oid = dependency.refobjid
    JOIN pg_namespace namespace ON namespace.oid = owner.relnamespace
    WHERE dependency.classid = 'pg_class'::regclass
      AND dependency.deptype IN ('a', 'i')
      AND namespace.nspname = 'public'
      AND owner.relname NOT LIKE 'drizzle_%'
      -- CASE, not AND: the planner may test this before the joins filter
      -- out non-sequences, and it fails on any other relation.
      AND CASE WHEN sequence_class.relkind = 'S'
        THEN pg_sequence_last_value(sequence_class.oid) IS NOT NULL
        ELSE false END
  `);
  if (usedSequences.rows.length > 0) {
    await client.exec(
      usedSequences.rows
        .map(({ sequence }) => `ALTER SEQUENCE ${sequence} RESTART;`)
        .join("\n"),
    );
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function installDatabase(client: PGlite): TestDatabase {
  pgliteClient = client;
  onDatabaseAccess(client, () => {
    databaseTouched = true;
  });
  testDb = drizzle({ client });
  return testDb;
}

// The database a shared worker keeps between files (keepDatabaseForNextFile).
// Setup runs again for every file, so it lives on the global object.
const KEPT_DATABASE = Symbol.for("archestra.test.keptPglite");
const LOADED_STATES = Symbol.for("archestra.test.loadedPgliteStates");
interface KeptDatabase {
  client: PGlite;
  snapshotPath: string;
}
// The state each database had when its snapshot loaded, kept on the global
// object with the database itself.
const loadedStatesStore = globalThis as {
  [LOADED_STATES]?: WeakMap<PGlite, Promise<string>>;
};
loadedStatesStore[LOADED_STATES] ??= new WeakMap();
const loadedStates = loadedStatesStore[LOADED_STATES];

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
