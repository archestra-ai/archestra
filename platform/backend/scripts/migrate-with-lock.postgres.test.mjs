// Real PostgreSQL is required: PGlite cannot hold a lock across connections.
// ARCHESTRA_MIGRATION_TEST_DATABASE_URL names a server whose user can create
// databases and the vector extension. CI runs this in OpenAPPA Native Tests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
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

test("builds the MCP service-account index without blocking writes and recovers an interrupted build", {
  skip: !serverUrl && "set ARCHESTRA_MIGRATION_TEST_DATABASE_URL",
  timeout: 180_000,
}, async (t) => {
  const name = `mcp_index_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  const clients = [];
  const runs = [];
  let fixture;
  let writing;
  let keepWriting = false;
  t.after(async () => {
    keepWriting = false;
    await writing;
    await Promise.allSettled(clients.map((client) => client.end()));
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    for (const run of runs) if (!run.exited) run.stop();
    await admin.end();
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
  });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  url.search = "";
  const databaseUrl = url.toString();
  fixture = await mcpIndexFixture();
  const startMigration = () => {
    const run = migrate(databaseUrl, fixture.directory);
    runs.push(run);
    return run;
  };
  const connect = async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    clients.push(client);
    await client.connect();
    return client;
  };
  const database = await connect();
  const holder = await connect();
  const writer = await connect();

  const initial = await startMigration().done;
  assert.equal(initial.code, 0, initial.output);
  const account = randomUUID();
  await database.query("INSERT INTO service_accounts (id) VALUES ($1)", [
    account,
  ]);
  const seedStarted = Date.now();
  await database.query(
    `
    INSERT INTO mcp_tool_calls (payload)
    SELECT repeat(md5(value::text), 8)
    FROM generate_series(1, 1000000) AS value
  `,
  );
  const seededMs = Date.now() - seedStarted;
  await database.query("ANALYZE mcp_tool_calls");
  await fixture.addAttributionAndLaterMigration();

  // An older snapshot on another table lets ADD COLUMN commit, then holds the
  // concurrent build at its snapshot wait without blocking log inserts.
  await holder.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await holder.query("SELECT id FROM service_accounts");
  const holderStarted = Date.now();
  const interrupted = startMigration();
  const buildPid = await waitForIndexBuild(database);
  const buildPhase = (
    await database.query(
      "SELECT phase FROM pg_stat_progress_create_index WHERE pid = $1",
      [buildPid],
    )
  ).rows[0].phase;
  assert.equal(buildPhase, "waiting for old snapshots");
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS count FROM mcp_tool_calls WHERE service_account_id IS NOT NULL",
      )
    ).rows[0].count,
    0,
    "historical rows must remain unattributed",
  );
  await database.query(
    `INSERT INTO mcp_tool_calls (service_account_id, payload)
     SELECT $1, 'new attributed log' FROM generate_series(1, 10000)`,
    [account],
  );
  await writer.query("SET statement_timeout = '1s'");
  const waitingSince = Date.now();
  let writes = 0;
  let maxWriteMs = 0;
  let writerError;
  keepWriting = true;
  writing = (async () => {
    while (keepWriting) {
      const started = Date.now();
      await writer.query(
        "INSERT INTO mcp_tool_calls (payload) VALUES ('concurrent writer')",
      );
      maxWriteMs = Math.max(maxWriteMs, Date.now() - started);
      writes++;
      await sleep(10);
    }
  })().catch((error) => {
    writerError = error;
  });
  while (Date.now() - waitingSince < 6_000) {
    await sleep(100);
    assert.equal(interrupted.exited, false, interrupted.output());
    assert.equal(writerError, undefined);
  }
  assert.ok(
    writes > 0,
    "writes must continue while the index waits for the older transaction",
  );
  assert.equal(
    (
      await database.query("SELECT pg_cancel_backend($1) AS cancelled", [
        buildPid,
      ])
    ).rows[0].cancelled,
    true,
  );
  const cancelled = await interrupted.done;
  assert.notEqual(cancelled.code, 0, cancelled.output);
  assert.equal(await mcpIndexValidity(database), false);
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
      )
    ).rows[0].count,
    1,
    "the failed combined migration must not be recorded despite its committed DDL",
  );
  assert.deepEqual(
    (
      await database.query(
        `SELECT convalidated, confdeltype FROM pg_constraint
         WHERE conrelid = 'mcp_tool_calls'::regclass
           AND conname = 'mcp_tool_calls_service_account_id_service_accounts_id_fk'`,
      )
    ).rows,
    [{ convalidated: false, confdeltype: "n" }],
    "the unvalidated SET NULL foreign key must survive the interrupted build",
  );
  assert.equal(
    (
      await database.query(
        "SELECT to_regclass('after_mcp_index_probe') AS name",
      )
    ).rows[0].name,
    null,
  );
  await holder.query("COMMIT");
  const heldSnapshotMs = Date.now() - holderStarted;

  const recoveryStarted = Date.now();
  const recovered = await startMigration().done;
  const recoveryMs = Date.now() - recoveryStarted;
  keepWriting = false;
  await writing;
  assert.equal(writerError, undefined);
  assert.equal(recovered.code, 0, recovered.output);
  assert.match(
    recovered.output,
    /Dropped invalid index mcp_tool_calls_service_account_id_idx left by an interrupted concurrent build/,
  );
  assert.equal(await mcpIndexValidity(database), true);
  assert.deepEqual(
    (await database.query("SELECT lock_timeout FROM after_mcp_index_probe"))
      .rows,
    [{ lock_timeout: "5s" }],
  );
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
      )
    ).rows[0].count,
    3,
  );
  const rerun = await startMigration().done;
  assert.equal(rerun.code, 0, rerun.output);
  assert.equal(await mcpIndexValidity(database), true);

  const definition = (
    await database.query(
      "SELECT pg_get_indexdef('mcp_tool_calls_service_account_id_idx'::regclass) AS definition",
    )
  ).rows[0].definition;
  assert.match(definition, /WHERE \(service_account_id IS NOT NULL\)/);
  const plan = await database.query(
    "EXPLAIN (FORMAT JSON) UPDATE mcp_tool_calls SET service_account_id = NULL WHERE service_account_id = $1",
    [account],
  );
  assert.match(
    JSON.stringify(plan.rows),
    /mcp_tool_calls_service_account_id_idx/,
  );
  const beforeDelete = (
    await database.query("SELECT count(*)::int AS count FROM mcp_tool_calls")
  ).rows[0].count;
  assert.equal(beforeDelete, 1_010_000 + writes);
  await database.query("DELETE FROM service_accounts WHERE id = $1", [account]);
  assert.equal(
    (await database.query("SELECT count(*)::int AS count FROM mcp_tool_calls"))
      .rows[0].count,
    beforeDelete,
  );
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS count FROM mcp_tool_calls WHERE service_account_id IS NOT NULL",
      )
    ).rows[0].count,
    0,
  );
  await assert.rejects(
    database.query(
      "INSERT INTO mcp_tool_calls (service_account_id) VALUES ($1)",
      [randomUUID()],
    ),
    /foreign key constraint/,
  );
  t.diagnostic(
    JSON.stringify({
      postgres: (await database.query("SHOW server_version")).rows[0]
        .server_version,
      seededRows: 1_000_000,
      seededMs,
      heldSnapshotMs,
      buildPhase,
      newAttributedRows: 10_000,
      committedDdlReplayed: true,
      concurrentWrites: writes,
      maxWriteMs,
      recoveryMs,
      interruptedBuildInvalid: true,
      recoveredIndexValid: true,
      laterMigrationApplied: true,
      lockTimeoutRestored: true,
      deletionPlanUsesIndex: true,
      auditRowsRetained: true,
    }),
  );
});

async function mcpIndexFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "archestra-mcp-index-"));
  const directory = path.join(root, "platform/backend");
  const scripts = path.join(directory, "scripts");
  const migrations = path.join(directory, "src/database/migrations");
  await mkdir(scripts, { recursive: true });
  await mkdir(path.join(migrations, "meta"), { recursive: true });
  for (const file of [
    "migrate-with-lock.mjs",
    "concurrent-index-leftovers.mjs",
    "rds-iam.mjs",
    "spinner-free-output.mjs",
  ])
    await copyFile(
      path.join(backend, "scripts", file),
      path.join(scripts, file),
    );
  await symlink(
    path.join(backend, "node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  await symlink(
    path.resolve(backend, "../node_modules"),
    path.join(root, "platform/node_modules"),
    "dir",
  );
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  await writeFile(
    path.join(directory, "drizzle.config.ts"),
    `import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "postgresql", out: "./src/database/migrations", dbCredentials: { url: process.env.ARCHESTRA_DATABASE_URL! } });\n`,
  );
  const source = path.join(backend, "src/database/migrations");
  const sourceJournal = JSON.parse(
    await readFile(path.join(source, "meta/_journal.json"), "utf8"),
  );
  const attribution = sourceJournal.entries.find(
    (entry) => entry.tag === "0646_a2a_service_account_attribution",
  );
  assert.ok(attribution, "the actual combined migration must be present");
  const entries = [
    { idx: 0, version: "7", when: 1000, tag: "bootstrap", breakpoints: true },
  ];
  const writeJournal = () =>
    writeFile(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries }),
    );
  // Autovacuum is off for the log table: the million seeded rows invite it,
  // and the rerun's ADD COLUMN IF NOT EXISTS then queues for its lock behind
  // autovacuum until deadlock_timeout (1s) cancels it, stalling the writer
  // past its 1s statement_timeout. That wait is not what the test measures,
  // and it runs ANALYZE itself.
  await writeFile(
    path.join(migrations, "bootstrap.sql"),
    `CREATE TABLE service_accounts (id uuid PRIMARY KEY);--> statement-breakpoint
CREATE TABLE mcp_tool_calls (id bigserial PRIMARY KEY, payload text, created_at timestamptz NOT NULL DEFAULT now()) WITH (autovacuum_enabled = false);`,
  );
  await writeJournal();
  return {
    root,
    directory,
    async addAttributionAndLaterMigration() {
      await copyFile(
        path.join(source, `${attribution.tag}.sql`),
        path.join(migrations, `${attribution.tag}.sql`),
      );
      await writeFile(
        path.join(migrations, "after_index.sql"),
        `CREATE TABLE after_mcp_index_probe (lock_timeout text NOT NULL);--> statement-breakpoint
INSERT INTO after_mcp_index_probe VALUES (current_setting('lock_timeout'));`,
      );
      entries.push(
        { ...attribution, idx: 1 },
        {
          idx: 2,
          version: "7",
          when: attribution.when + 1,
          tag: "after_index",
          breakpoints: true,
        },
      );
      await writeJournal();
    },
  };
}

async function waitForIndexBuild(database) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { rows } = await database.query(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state = 'active' AND wait_event_type = 'Lock'
        AND query LIKE '%CREATE INDEX CONCURRENTLY IF NOT EXISTS "mcp_tool_calls_service_account_id_idx"%'`);
    if (rows[0]) return rows[0].pid;
    await sleep(25);
  }
  throw new Error(
    "the concurrent index build did not wait for the older writer",
  );
}

async function mcpIndexValidity(database) {
  const { rows } =
    await database.query(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'mcp_tool_calls_service_account_id_idx'`);
  return rows[0]?.valid ?? null;
}

function migrate(databaseUrl, cwd = backend) {
  let output = "";
  const child = spawn(process.execPath, ["scripts/migrate-with-lock.mjs"], {
    cwd,
    env: {
      ...process.env,
      ARCHESTRA_DATABASE_URL: databaseUrl,
      PGOPTIONS: "-c lock_timeout=5s",
    },
  });
  const run = {
    exited: false,
    output: () => output,
    stop: () => child.kill("SIGTERM"),
  };
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
