import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import { wrapPoolWithRetry } from "../src/database/retry";

// PGlite cannot exercise independent connections or PostgreSQL lock detection.
// Run explicitly with the same isolated database as the native integration tests:
// pnpm --dir backend exec tsx --test scripts/database-retry-postgres.test.ts
const connectionString = process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL;
assert.ok(connectionString, "An isolated PostgreSQL test database is required");

test("an autocommit deadlock victim recovers without replaying a transaction", async () => {
  const applicationName = `retry-test-${randomUUID()}`;
  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: applicationName,
  });
  const blocker = new Client({ connectionString });
  const observer = new Client({ connectionString });
  await blocker.connect();
  await observer.connect();
  wrapPoolWithRetry(pool);
  // Advisory locks let us create a real server deadlock without table changes.
  const key = Math.floor(Math.random() * 1_000_000_000);
  let blocked: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1)", [key + 1]);
    const pending = pool.query(
      "WITH first_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock($1)) SELECT pg_advisory_xact_lock($2) FROM first_lock",
      [key, key + 1],
    );
    // Attach rejection immediately so the baseline failure is not unhandled.
    const completed = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const deadline = Date.now() + 5_000;
    while (true) {
      const { rows } = await observer.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'",
        [applicationName],
      );
      if (rows.length) break;
      assert.ok(Date.now() < deadline, "statement did not enter its lock wait");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The first waiter runs deadlock detection first and is the victim. Once
    // it rolls back, this transaction finishes and releases the second lock.
    blocked = blocker
      .query("SELECT pg_advisory_xact_lock($1)", [key])
      .then(() => blocker.query("COMMIT"));
    const outcome = await completed;
    if ("error" in outcome) throw outcome.error;
    assert.equal(outcome.value.rowCount, 1);
    await blocked;
    const { rows } = await pool.query("SELECT 1 AS healthy");
    assert.equal(rows[0].healthy, 1);
  } finally {
    await blocker.query("ROLLBACK");
    await blocked?.catch(() => undefined);
    await Promise.all([pool.end(), blocker.end(), observer.end()]);
  }
});
