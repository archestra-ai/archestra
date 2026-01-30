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
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

// Disable Sentry for tests - set BEFORE any config modules are loaded
process.env.ARCHESTRA_SENTRY_BACKEND_DSN = "";
process.env.ARCHESTRA_SENTRY_ENVIRONMENT = "test";

// Set auth secret for tests
process.env.ARCHESTRA_AUTH_SECRET = "auth-secret-unit-tests-32-chars!";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level variables to persist across tests within a file
let pgliteClient: PGlite | null = null;
let testDb: ReturnType<typeof drizzle> | null = null;
let migrationsSql: string[] | null = null;

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
  // Create a new in-memory PGlite instance
  pgliteClient = new PGlite("memory://");
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
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  testDb = null;
});
