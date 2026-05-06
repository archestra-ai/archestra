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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

// Disable Sentry for tests - set BEFORE any config modules are loaded
process.env.ARCHESTRA_SENTRY_BACKEND_DSN = "";
process.env.ARCHESTRA_SENTRY_ENVIRONMENT = "test";
// Silence backend pino output during unit tests while preserving logger calls for spies/assertions.
process.env.ARCHESTRA_LOGGING_LEVEL = "silent";
// Enable enterprise white-labeling in backend tests so branding-aware helpers
// exercise the branded built-in MCP paths instead of the default prefix.
process.env.ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING = "true";

// Set auth secret for tests
process.env.ARCHESTRA_AUTH_SECRET = "auth-secret-unit-tests-32-chars!";

// Vitest file workers can stack multiple process-level exit listeners during
// backend test setup/teardown; raise the cap slightly to avoid noisy warnings.
process.setMaxListeners(20);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level variables to persist across tests within a file
let pgliteClient: PGlite | null = null;
let testDb: ReturnType<typeof drizzle> | null = null;
let migrationsSql: string[] | null = null;
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
 * Read and cache migration files - done once per worker
 */
function getMigrationsSql(): string[] {
  if (migrationsSql) return migrationsSql;

  const migrationsDir = path.join(__dirname, "../database/migrations");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort(); // Ensure consistent order

  migrationsSql = migrationFiles.map((file) =>
    fs.readFileSync(path.join(migrationsDir, file), "utf8"),
  );

  return migrationsSql;
}

/**
 * Initialize the database once per test file.
 * This runs the migrations once, which is the expensive operation.
 */
beforeAll(async () => {
  // Create a new in-memory PGlite instance with pgvector extension
  pgliteClient = new PGlite("memory://", { extensions: { vector } });
  testDb = drizzle({ client: pgliteClient });

  // Run all migrations once
  const migrations = getMigrationsSql();
  for (const migrationSql of migrations) {
    await pgliteClient.exec(migrationSql);
  }

  // Set the test database via the internal setter (for getDb() and proxy)
  const dbModule = await import("../database/index.js");
  dbModule.__setTestDb(
    testDb as unknown as Parameters<typeof dbModule.__setTestDb>[0],
  );

  // Also replace the default export for compatibility
  Object.defineProperty(dbModule, "default", {
    value: testDb,
    writable: true,
    configurable: true,
  });
});

/**
 * Clean up tables before each test to ensure test isolation.
 * Using TRUNCATE CASCADE is the fastest way to clear all data.
 */
beforeEach(async () => {
  if (!pgliteClient) {
    throw new Error("Database not initialized. Did beforeAll run?");
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

  // NOTE: We intentionally do NOT seed organization or default agent here.
  // Tests that need them should use makeOrganization and makeAgent fixtures.
  // This allows organization tests to test both with and without existing organizations.
});

/**
 * Clear mocks after each test
 */
afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Clean up the PGlite client after all tests in the file complete
 */
afterAll(async () => {
  console.warn = originalConsoleWarn;

  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  testDb = null;
});
