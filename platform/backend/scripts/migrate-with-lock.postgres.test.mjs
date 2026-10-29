// Real PostgreSQL is required: PGlite cannot hold a lock across connections.
// ARCHESTRA_MIGRATION_TEST_DATABASE_URL names a server whose user can create
// databases and the vector extension. CI runs this in OpenAPPA Native Tests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const backend = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverUrl = process.env.ARCHESTRA_MIGRATION_TEST_DATABASE_URL;
// scripts/migrate-with-lock.mjs leases for 60 s and renews every 10 s.
const LEASE_TTL_MS = 60_000;

test("keeps the migration lease while index recovery waits longer than the lease lasts", {
  skip: !serverUrl && "set ARCHESTRA_MIGRATION_TEST_DATABASE_URL",
  timeout: 600_000,
}, async (t) => {
  const name = `migrate_lock_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.end()));
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  url.search = "";
  const databaseUrl = url.toString();

  assert.equal((await migrate(databaseUrl).done).code, 0);

  const database = new pg.Client({ connectionString: databaseUrl });
  const holder = new pg.Client({ connectionString: databaseUrl });
  clients.push(database, holder);
  await database.connect();
  await holder.connect();

  // Leave the invalid index that an interrupted concurrent build leaves:
  // the build gives up while a writer holds the table. The same writer then
  // keeps the recovery's DROP INDEX CONCURRENTLY waiting.
  await database.query('DROP INDEX "agents_model_id_idx"');
  await holder.query("BEGIN");
  await holder.query("LOCK TABLE agents IN ROW EXCLUSIVE MODE");
  await database.query("SET lock_timeout = '1s'");
  await assert.rejects(
    database.query(
      'CREATE INDEX CONCURRENTLY "agents_model_id_idx" ON "agents" ("model_id") WHERE "model_id" IS NOT NULL',
    ),
    /lock timeout/,
  );
  await database.query("RESET lock_timeout");
  assert.equal(await indexValidity(database), false);

  const run = migrate(databaseUrl);
  const waitUntil = Date.now() + LEASE_TTL_MS + 15_000;
  let lease;
  while (Date.now() < waitUntil) {
    await sleep(5_000);
    assert.equal(run.exited, false, run.output());
    const { rows } = await database.query(
      `SELECT holder, expires_at > clock_timestamp() AS live
           FROM drizzle.__archestra_migration_lock WHERE id = 1`,
    );
    assert.equal(rows.length, 1, "the lease row is gone");
    assert.equal(rows[0].live, true, "the lease expired while recovery waited");
    lease ??= rows[0].holder;
    assert.equal(rows[0].holder, lease, "the lease changed owners");
  }

  await holder.query("COMMIT");
  const result = await run.done;
  assert.equal(result.code, 0, result.output);
  assert.match(
    result.output,
    /Dropped invalid index agents_model_id_idx left by an interrupted concurrent build/,
  );
  assert.equal(await indexValidity(database), null);
  const remaining = await database.query(
    "SELECT count(*)::int AS count FROM drizzle.__archestra_migration_lock",
  );
  assert.equal(remaining.rows[0].count, 0);
});

function migrate(databaseUrl) {
  let output = "";
  const child = spawn(process.execPath, ["scripts/migrate-with-lock.mjs"], {
    cwd: backend,
    env: {
      ...process.env,
      ARCHESTRA_DATABASE_URL: databaseUrl,
      PGOPTIONS: "-c lock_timeout=5s",
    },
  });
  const run = { exited: false, output: () => output };
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  run.done = new Promise((resolve) => {
    child.on("exit", (code) => {
      run.exited = true;
      resolve({ code, output });
    });
  });
  return run;
}

async function indexValidity(database) {
  const { rows } = await database.query(
    `SELECT i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'agents_model_id_idx'`,
  );
  return rows[0]?.valid ?? null;
}
