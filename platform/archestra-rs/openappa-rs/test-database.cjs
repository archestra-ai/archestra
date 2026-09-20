/**
 * The real PostgreSQL the native tests run against.
 *
 * These are the only tests that exercise the real NAPI bridge and the real
 * ledger — everything above them mocks `@archestra/openappa-rs`. So a missing
 * database is a CI failure, not a skip: a suite that no-ops on the server reads
 * as coverage while verifying nothing, which is exactly how this hole went
 * unnoticed.
 *
 * The variable has to live in the `ARCHESTRA_*` namespace. Turbo runs in strict
 * env mode with `globalEnv: ["ARCHESTRA_*"]` (platform/turbo.json), so any other
 * spelling is stripped before `check:ci` reaches the test, and the tests would
 * skip with CI still green. The bare name stays accepted for local runs.
 *
 * Pass it WITHOUT a query string: the runtime's PostgreSQL driver rejects the
 * `?schema=public` that `ARCHESTRA_DATABASE_URL` carries with "invalid
 * connection string".
 *
 *   ARCHESTRA_OPENAPPA_TEST_DATABASE_URL=postgresql://user:pw@localhost:5432/db \
 *     node --test smoke.test.cjs policy.test.cjs
 *
 * The database must already carry Archestra's schema: the ledger tables are
 * created by the backend's Drizzle migrations, not by the runtime.
 */
const databaseUrl =
  process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL ||
  process.env.OPENAPPA_TEST_DATABASE_URL;

if (process.env.CI && !databaseUrl) {
  throw new Error(
    "ARCHESTRA_OPENAPPA_TEST_DATABASE_URL is required in CI: without it every real native and PostgreSQL test skips and this suite verifies nothing.",
  );
}

module.exports = { databaseUrl };
