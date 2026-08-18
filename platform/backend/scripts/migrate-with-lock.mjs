import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../.env",
  ),
  quiet: true,
});

const databaseUrl =
  process.env.ARCHESTRA_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Database URL is not set. Set ARCHESTRA_DATABASE_URL or DATABASE_URL.",
  );
}

const MIGRATION_LOCK_KEY = "742947119433676426";
const LEASE_ID = 1;
const LEASE_TTL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const ACQUIRE_RETRY_MS = 1_000;
const holder = randomUUID();
const client = new pg.Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
});
let leaseAcquired = false;

await client.connect();
try {
  await initializeLeaseTable();
  await acquireLease();
  leaseAcquired = true;

  let child;
  let heartbeatError;
  let heartbeatInFlight = Promise.resolve();
  const heartbeatTimer = setInterval(() => {
    if (heartbeatError) return;
    heartbeatInFlight = heartbeatInFlight
      .then(renewLease)
      .catch((error) => {
        heartbeatError = error;
        child?.kill("SIGTERM");
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  let migrationError;
  try {
    child = spawn("./node_modules/.bin/drizzle-kit", ["migrate"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    await waitForChild(child);
  } catch (error) {
    migrationError = error;
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatInFlight;
  }

  if (heartbeatError) {
    throw new AggregateError(
      migrationError ? [heartbeatError, migrationError] : [heartbeatError],
      "Lost the database migration lease while migrations were running",
    );
  }
  if (migrationError) throw migrationError;
} finally {
  try {
    if (leaseAcquired) {
      await client.query(
        'DELETE FROM "drizzle"."__archestra_migration_lock" WHERE id = $1 AND holder = $2',
        [LEASE_ID, holder],
      );
    }
  } finally {
    await client.end();
  }
}

async function initializeLeaseTable() {
  await client.query("BEGIN");
  try {
    // The transaction lock only serializes first-time table creation. The
    // durable lease row below protects the migration child across its commits.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__archestra_migration_lock" (
        id integer PRIMARY KEY,
        holder text NOT NULL,
        expires_at timestamptz NOT NULL,
        CONSTRAINT "__archestra_migration_lock_singleton" CHECK (id = 1)
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function acquireLease() {
  while (true) {
    const result = await client.query(
      `
        INSERT INTO "drizzle"."__archestra_migration_lock" (id, holder, expires_at)
        VALUES ($1, $2, clock_timestamp() + $3 * interval '1 millisecond')
        ON CONFLICT (id) DO UPDATE
        SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
        WHERE "__archestra_migration_lock".expires_at <= clock_timestamp()
        RETURNING holder
      `,
      [LEASE_ID, holder, LEASE_TTL_MS],
    );
    if (result.rowCount === 1) return;
    await sleep(ACQUIRE_RETRY_MS);
  }
}

async function renewLease() {
  const result = await client.query(
    `
      UPDATE "drizzle"."__archestra_migration_lock"
      SET expires_at = clock_timestamp() + $3 * interval '1 millisecond'
      WHERE id = $1 AND holder = $2 AND expires_at > clock_timestamp()
    `,
    [LEASE_ID, holder, LEASE_TTL_MS],
  );
  if (result.rowCount !== 1) {
    throw new Error("Database migration lease expired or changed owners");
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `drizzle-kit migrate exited from signal ${signal}`
            : `drizzle-kit migrate exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}
