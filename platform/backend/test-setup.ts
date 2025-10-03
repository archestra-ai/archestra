/**
 * Basically for backend tests we use pglite instead of Postgres
 *
 * See this blog post for more details:
 * https://dev.to/benjamindaniel/how-to-test-your-nodejs-postgres-app-using-drizzle-pglite-4fb3
 */

import { beforeEach } from 'vitest';
import { drizzle } from "drizzle-orm/pglite";
import path from "node:path";
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

beforeEach(async () => {
  const pgliteClient = new PGlite();
  // Create an in-memory database for tests
  const testDb = drizzle({ client: pgliteClient });

  /**
   * Run migrations on test database, we could simply use the migrate function that is
   * exported by drizzle-orm/pglite/migrator, but it's not working as expected.
   *
   * Was running into the issue reported here: https://github.com/electric-sql/pglite/issues/627
   *
   * So decided to just run the migrations manually.
   */
  const migrationFiles = fs.readdirSync(path.join(__dirname, './src/database/migrations')).filter(file => file.endsWith('.sql'));
  for (const migrationFile of migrationFiles) {
    await pgliteClient.exec(fs.readFileSync(path.join(__dirname, './src/database/migrations', migrationFile), 'utf8'));
  }
  // await migrate(testDb, { migrationsFolder: path.join(__dirname, './src/database/migrations') });

  // Set the test database in the mock
  const { setMockDb } = await import('./src/database/__mocks__/index.js');
  setMockDb(testDb);
});
