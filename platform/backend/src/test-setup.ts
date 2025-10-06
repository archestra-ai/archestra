/**
 * Basically for backend tests we use pglite instead of Postgres
 *
 * See this blog post for more details:
 * https://dev.to/benjamindaniel/how-to-test-your-nodejs-postgres-app-using-drizzle-pglite-4fb3
 */

import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { vi } from "vitest";

let pgliteClient: PGlite | null = null;
let testDb: ReturnType<typeof drizzle> | null = null;

beforeEach(async () => {
  pgliteClient = new PGlite("memory://");
  // Create an in-memory database for tests
  testDb = drizzle({ client: pgliteClient });

  /**
   * Run migrations on test database, we could simply use the migrate function that is
   * exported by drizzle-orm/pglite/migrator, but it's not working as expected.
   *
   * Was running into the issue reported here: https://github.com/electric-sql/pglite/issues/627
   *
   * So decided to just run the migrations manually.
   */
  const migrationFiles = fs
    .readdirSync(path.join(__dirname, "./database/migrations"))
    .filter((file) => file.endsWith(".sql"));
  for (const migrationFile of migrationFiles) {
    await pgliteClient.exec(
      fs.readFileSync(
        path.join(__dirname, "./database/migrations", migrationFile),
        "utf8",
      ),
    );
  }

  // Replace the mocked database module with our test database
  const dbModule = await import("./database/index.js");

  // Replace the default export with our test database
  Object.defineProperty(dbModule, "default", {
    value: testDb,
    writable: true,
    configurable: true,
  });
});

afterEach(async () => {
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  testDb = null;

  // Clear all mocks
  vi.clearAllMocks();
});
