// The backend program of supervisor.mjs.
//
// Runs as soon as the supervisor starts, alongside the bundled PostgreSQL and
// the frontend, instead of after fixed sleeps:
// - waits for the bundled PostgreSQL to accept connections (an external
//   database is not waited for: the migrations report its errors)
// - runs the migrations, unless maintenance mode or
//   ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP=false turns them off
// - then becomes the server (backend/scripts/start-production.mjs)
// In quickstart mode it does not wait for the embedded KinD cluster: the
// backend attaches to it when docker-entrypoint.sh publishes its kubeconfig.

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BACKEND_DIR = "/app/backend";
const BUNDLED_DATABASE_WAIT_MS = 60_000;

process.chdir(BACKEND_DIR);

// Maintenance mode must be able to boot when the external database is down
// for planned work, so it skips the database wait and the migrations.
if (!process.env.ARCHESTRA_MAINTENANCE_MODE_MESSAGE) {
  // The supervisor sets this only when it runs the bundled database, whose
  // image has pg_isready.
  if (process.env.ARCHESTRA_DATABASE_BUNDLED === "true") {
    const deadline = Date.now() + BUNDLED_DATABASE_WAIT_MS;
    while (
      // Probe as the postgres role: without -U the probe uses this process's
      // OS user (root), and the server logs "FATAL: role "root" does not exist".
      spawnSync("pg_isready", [
        "-q",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ]).status !== 0
    ) {
      if (Date.now() > deadline) {
        console.error(
          "PostgreSQL is still not accepting connections after 60s; starting anyway",
        );
        break;
      }
      await sleep(100);
    }
  }

  if (process.env.ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP !== "false") {
    const migrate = spawnSync(process.execPath, ["./scripts/migrate-with-lock.mjs"], {
      stdio: "inherit",
    });
    if (migrate.status !== 0) process.exit(migrate.status ?? 1);
  }
}

await import(`${BACKEND_DIR}/scripts/start-production.mjs`).then(({ main }) => main());
