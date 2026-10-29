// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// Real PostgreSQL is required: PGlite cannot establish cross-connection lock behavior.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const backend = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("large stable upgrade, concurrent replicas, interrupted owner, and restart fast path", {
  timeout: 1_200_000,
}, async (t) => {
  const container = `archestra-permission-upgrade-${randomUUID()}`;
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "permission-upgrade-"),
  );
  let admin;
  let pool;
  let resetDb;
  t.after(async () => {
    resetDb?.(null);
    await pool?.end();
    await admin?.end();
    try {
      execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "-e",
      "POSTGRESQL_PASSWORD=upgrade_test",
      "-e",
      "POSTGRESQL_DATABASE=upgrade_test",
      "-p",
      "127.0.0.1::5432",
      "registry-1.docker.io/bitnamisecure/postgresql:latest",
    ],
    { stdio: "pipe" },
  );
  const port = execFileSync(
    "docker",
    [
      "inspect",
      "-f",
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      container,
    ],
    { encoding: "utf8" },
  ).trim();
  const connectionString = `postgresql://postgres:upgrade_test@127.0.0.1:${port}/upgrade_test`;
  admin = new pg.Pool({ connectionString });
  let connected = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await admin.query("SELECT 1");
      connected = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  assert.ok(connected, "disposable PostgreSQL must become available");

  const source = execFileSync(
    "git",
    ["tag", "--list", "platform-v1.3.*", "--sort=-version:refname"],
    { cwd: backend, encoding: "utf8" },
  )
    .trim()
    .split("\n")[0];
  assert.ok(source, "fetch stable release tags before running");
  const migrationsPath = "platform/backend/src/database/migrations";
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: backend,
    encoding: "utf8",
  }).trim();
  const archive = execFileSync(
    "git",
    ["-C", root, "archive", source, migrationsPath],
    { cwd: backend, maxBuffer: 512 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
  const database = drizzle(admin);
  await migrate(database, {
    migrationsFolder: path.join(directory, migrationsPath),
  });
  await admin.query(LEGACY_DATA);
  const started = performance.now();
  await migrate(database, {
    migrationsFolder: path.join(backend, "src/database/migrations"),
  });
  t.diagnostic(
    `${source} schema upgrade: ${Math.round(performance.now() - started)} ms`,
  );

  // This pool models ordinary API connections with a short request timeout.
  pool = new pg.Pool({
    connectionString,
    options: "-c statement_timeout=250ms",
    max: 8,
  });
  // Killing the owning PostgreSQL session also emits an idle-client error
  // after Drizzle's rollback attempt. This is expected for this fault test.
  pool.on("error", (error) => {
    assert.match(error.message, /Connection terminated|terminating connection/);
  });
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      assert.match(
        error.message,
        /Connection terminated|terminating connection/,
      );
    });
  });
  process.env.ARCHESTRA_DATABASE_URL = connectionString;
    const { __setTestDb } = await import("../src/database/index.ts");
  resetDb = __setTestDb;
  __setTestDb(drizzle(pool));
  const { sql } = await import("drizzle-orm");
  const { default: StartupMigrationModel } = await import(
    "../src/models/startup-migration.ts"
  );
  const { ensureScopedResourcePermissionCutover } = await import(
    "../src/services/resource-permissions-cutover.ts"
  );

  await t.test(
    "a peer does not wait on the owner's SQL lock, and termination permits takeover",
    async () => {
      let ownerPid;
      let announceOwner;
      const ownerStarted = new Promise((resolve) => {
        announceOwner = resolve;
      });
      const owner = StartupMigrationModel.tryRun({
        id: "interruption-test",
        migrate: async (tx) => {
          await tx.execute(
            sql`INSERT INTO startup_migrations (id) VALUES ('uncommitted-effect')`,
          );
          ownerPid = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`))
            .rows[0].pid;
          announceOwner();
          await tx.execute(sql`SELECT pg_sleep(30)`);
        },
      });
      const rejection = assert.rejects(owner);
      await ownerStarted;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          assert.equal(
            await StartupMigrationModel.tryRun({
              id: "interruption-test",
              migrate: async () => {
                assert.fail("peer ran the upgrade");
              },
            }),
            false,
          );
        }
      } finally {
        await admin.query("SELECT pg_terminate_backend($1)", [ownerPid]);
      }
      await rejection;
      // A replacement replica has fresh connections, rather than the killed
      // process's pool (which can briefly still contain its disconnected client).
      await pool.end();
      pool = new pg.Pool({
        connectionString,
        options: "-c statement_timeout=250ms",
        max: 8,
      });
      __setTestDb(drizzle(pool));
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM startup_migrations",
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        await StartupMigrationModel.tryRun({
          id: "interruption-test",
          migrate: async (tx) => {
            await tx.execute(sql`SELECT pg_sleep(0.5)`);
          },
        }),
        true,
      );
      assert.equal(
        (await pool.query("SHOW statement_timeout")).rows[0].statement_timeout,
        "250ms",
      );
    },
  );

  await t.test(
    "four starting replicas convert the large legacy deployment once",
    async () => {
      const start = performance.now();
      await Promise.all(
        Array.from({ length: 4 }, () =>
          ensureScopedResourcePermissionCutover(),
        ),
      );
      t.diagnostic(
        `20,000 members, 2,000 agents, 20,000 chats, four replicas: ${Math.round(performance.now() - start)} ms`,
      );
      const result =
        await admin.query(`SELECT resource, count(*)::int AS count FROM resource_permission_policies
      WHERE organization_id = 'upgrade-org' AND scope <> '*' AND legacy_sharing_migrated GROUP BY resource`);
      assert.equal(
        result.rows.find((row) => row.resource === "agent")?.count,
        2000,
      );
      assert.equal(
        result.rows.find((row) => row.resource === "conversation")?.count,
        20000,
      );
      const personal = (
        await admin.query(`SELECT grants FROM resource_permission_policies
      WHERE organization_id = 'upgrade-org' AND resource = 'agent'
        AND scope = '10000000-0000-4000-8000-000000000001'`)
      ).rows[0];
      assert.ok(
        personal.grants.some(
          (grant) =>
            grant.subject.type === "user" &&
            grant.subject.id === "upgrade-user-1" &&
            grant.actions.includes("manage-permissions"),
        ),
      );
      const shared = (
        await admin.query(`SELECT grants FROM resource_permission_policies
      WHERE organization_id = 'upgrade-org' AND resource = 'agent'
        AND scope = '10000000-0000-4000-8000-000000000002'`)
      ).rows[0];
      assert.ok(
        shared.grants.some(
          (grant) =>
            grant.subject.type === "user" &&
            grant.subject.id === "upgrade-user-102" &&
            grant.actions.includes("manage-permissions"),
        ),
        "legacy editor team authority survives",
      );
    },
  );

  await t.test(
    "restarts preserve revocations and do not acquire permission table locks",
    async () => {
      await admin.query(`UPDATE resource_permission_policies SET grants = '[]'::jsonb, revision = revision + 1
      WHERE organization_id = 'upgrade-org' AND resource = 'agent' AND scope = '10000000-0000-4000-8000-000000000001'`);
      const blocker = await admin.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "LOCK TABLE resource_permission_policies IN ACCESS EXCLUSIVE MODE",
        );
        const start = performance.now();
        await Promise.all(
          Array.from({ length: 4 }, () =>
            ensureScopedResourcePermissionCutover(),
          ),
        );
        t.diagnostic(
          `four restarts with permission table exclusively locked: ${Math.round(performance.now() - start)} ms`,
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      assert.deepEqual(
        (
          await admin.query(`SELECT grants FROM resource_permission_policies
      WHERE organization_id = 'upgrade-org' AND resource = 'agent' AND scope = '10000000-0000-4000-8000-000000000001'`)
        ).rows[0].grants,
        [],
      );
    },
  );
});

const LEGACY_DATA = `
INSERT INTO organization (id, name, slug, created_at) VALUES ('upgrade-org', 'Upgrade Test', 'upgrade-test', now());
INSERT INTO "user" (id, name, email)
  SELECT 'upgrade-user-' || n, 'Synthetic User ' || n, 'upgrade-' || n || '@example.com' FROM generate_series(1, 20000) n;
INSERT INTO member (id, organization_id, user_id, role, created_at)
  SELECT 'upgrade-member-' || n, 'upgrade-org', 'upgrade-user-' || n, 'editor', now() FROM generate_series(1, 20000) n;
INSERT INTO team (id, name, organization_id, created_by, created_at, updated_at)
  SELECT 'upgrade-team-' || n, 'Synthetic Team ' || n, 'upgrade-org', 'upgrade-user-1', now(), now() FROM generate_series(0, 99) n;
INSERT INTO team_member (id, team_id, user_id, created_at)
  SELECT 'upgrade-team-member-' || n, 'upgrade-team-' || (n % 100), 'upgrade-user-' || n, now() FROM generate_series(1, 20000) n;
INSERT INTO agents (id, name, organization_id, agent_type, author_id, scope)
  SELECT ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Synthetic Agent ' || n, 'upgrade-org', 'agent', 'upgrade-user-1',
    CASE n % 3 WHEN 0 THEN 'org' WHEN 1 THEN 'personal' ELSE 'team' END FROM generate_series(1, 2000) n;
INSERT INTO agent_team (agent_id, team_id)
  SELECT ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'upgrade-team-' || (n % 100) FROM generate_series(1, 2000) n WHERE n % 3 = 2;
INSERT INTO conversations (id, title, organization_id, user_id, agent_id)
  SELECT ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Synthetic Chat ' || n, 'upgrade-org', 'upgrade-user-' || n, '10000000-0000-4000-8000-000000000001'::uuid
  FROM generate_series(1, 20000) n;
`;
