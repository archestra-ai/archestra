// Runs the platform image's processes in one container, in place of
// supervisord (which needed Python): the bundled PostgreSQL (full image, no
// ARCHESTRA_DATABASE_URL), the backend, the frontend, and the one-shot startup
// banner. docker-entrypoint.sh prepares the environment and execs this as the
// container's main process.
//
// - Each process inherits the container's stdout and stderr.
// - A process that exits on its own is started again, after a delay that
//   doubles from 1s to 30s while it keeps failing within a minute of starting.
// - SIGTERM or SIGINT stops the frontend and the backend together, then
//   PostgreSQL. Each gets SIGTERM, then SIGKILL to its whole process group if
//   it is still running after its stop timeout (the backend's comes from
//   shutdown-budget.mjs, through ARCHESTRA_SERVER_SUPERVISOR_STOP_SECONDS).
//   The supervisor exits 0 once all have stopped.
//
// Usage: node supervisor.mjs [--postgres]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ===
// Public interface
// ===

/** The platform's programs, in start order. */
export function platformPrograms({ env, bundledPostgres }) {
  const programs = [];
  if (bundledPostgres) {
    const { uid, gid } = systemUser("postgres");
    programs.push({
      name: "postgres",
      // `fatal` drops the startup banner and per-session warnings (PostgreSQL
      // ranks LOG above ERROR here) but keeps FATAL and PANIC; the backend
      // logs every query failure itself. log_checkpoints=off drops the two
      // lines PostgreSQL 15+ writes every checkpoint_timeout.
      command: [
        "postgres",
        "-D",
        "/var/lib/postgresql/data",
        "-c",
        "log_min_messages=fatal",
        "-c",
        "log_checkpoints=off",
      ],
      uid,
      gid,
      stopSeconds: 30,
      restart: true,
      stage: "last",
    });
  }
  programs.push(
    {
      name: "backend",
      // Waits for the bundled database, runs the migrations, then the server.
      command: ["/app/start-backend.sh"],
      cwd: "/app/backend",
      env: bundledPostgres ? { ARCHESTRA_DATABASE_BUNDLED: "true" } : {},
      stopSeconds: positiveInteger(
        env.ARCHESTRA_SERVER_SUPERVISOR_STOP_SECONDS,
        90,
      ),
      restart: true,
      stage: "first",
    },
    {
      name: "frontend",
      command: ["node", "server.js"],
      cwd: "/app/frontend",
      env: frontendEnv(env),
      stopSeconds: 10,
      restart: true,
      stage: "first",
    },
    {
      name: "startup-banner",
      command: ["/app/docker-banner.sh"],
      stopSeconds: 5,
      restart: false,
      stage: "first",
    },
  );
  return programs;
}

export class Supervisor {
  constructor({ programs, env = process.env, log = defaultLog }) {
    this.programs = programs.map((program) => ({
      ...program,
      child: null,
      failures: 0,
      timer: null,
    }));
    this.env = env;
    this.log = log;
    this.stopping = null;
  }

  start() {
    for (const program of this.programs) this.launch(program);
  }

  /** Stops every program; resolves when all have exited. */
  stop() {
    this.stopping ??= (async () => {
      for (const program of this.programs) clearTimeout(program.timer);
      await Promise.all(
        this.programs
          .filter((program) => program.stage !== "last")
          .map((program) => this.terminate(program)),
      );
      await Promise.all(
        this.programs
          .filter((program) => program.stage === "last")
          .map((program) => this.terminate(program)),
      );
    })();
    return this.stopping;
  }

  // ===
  // Private
  // ===

  launch(program) {
    if (this.stopping) return;
    const [command, ...args] = program.command;
    const startedAt = Date.now();
    // detached: its own process group, so a stop timeout can kill the
    // processes it started too (start-backend.sh's children).
    const child = spawn(command, args, {
      cwd: program.cwd,
      env: { ...this.env, ...program.env },
      stdio: "inherit",
      detached: true,
      ...(program.uid === undefined ? {} : { uid: program.uid, gid: program.gid }),
    });
    program.child = child;
    child.exited = new Promise((resolve) => {
      let done = false;
      // A process that cannot be spawned (a missing binary) emits only
      // `error`; one that ran emits `exit`. Either ends this run once.
      const ended = (reason) => {
        if (done) return;
        done = true;
        resolve();
        if (program.child === child) program.child = null;
        if (this.stopping) return;
        if (!program.restart) {
          if (reason !== 0) this.log(`${program.name} exited (${reason})`);
          return;
        }
        program.failures =
          Date.now() - startedAt < RESET_AFTER_MS ? program.failures + 1 : 1;
        const delay = Math.min(
          MAX_RESTART_DELAY_MS,
          1000 * 2 ** (program.failures - 1),
        );
        this.log(
          `${program.name} exited (${reason}); restarting in ${delay / 1000}s`,
        );
        program.timer = setTimeout(() => this.launch(program), delay);
      };
      child.on("error", (error) => ended(`could not start: ${error.message}`));
      child.on("exit", (code, signal) => ended(signal ?? code));
    });
  }

  async terminate(program) {
    const child = program.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    signal(child.pid, "SIGTERM");
    const timeout = setTimeout(() => {
      this.log(
        `${program.name} did not stop within ${program.stopSeconds}s; killing it`,
      );
      signal(-child.pid, "SIGKILL");
    }, program.stopSeconds * 1000);
    await child.exited;
    clearTimeout(timeout);
  }
}

// ===
// Internal helpers
// ===

const RESET_AFTER_MS = 60_000;
const MAX_RESTART_DELAY_MS = 30_000;

/**
 * The Next.js standalone server's own variable names, mapped from the
 * container's ARCHESTRA_* settings. HOSTNAME=0.0.0.0 makes it bind every
 * interface (otherwise only the container's IP, which breaks
 * `kubectl port-forward`); KEEP_ALIVE_TIMEOUT is its idle keep-alive window,
 * shared with the backend through ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS.
 */
function frontendEnv(env) {
  return {
    HOSTNAME: "0.0.0.0",
    KEEP_ALIVE_TIMEOUT: env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS ?? "",
    NEXT_PUBLIC_ARCHESTRA_API_BASE_URL: env.ARCHESTRA_API_BASE_URL ?? "",
    NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN:
      env.ARCHESTRA_SENTRY_FRONTEND_DSN ?? "",
    NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT:
      env.ARCHESTRA_SENTRY_ENVIRONMENT ?? "",
    NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED:
      env.ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED ?? "",
    NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING:
      env.ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING ?? "",
  };
}

function systemUser(name) {
  const line = readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${name}:`));
  if (!line) throw new Error(`no ${name} user in /etc/passwd`);
  const [, , uid, gid] = line.split(":");
  return { uid: Number(uid), gid: Number(gid) };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function defaultLog(message) {
  process.stderr.write(`[supervisor] ${message}\n`);
}

function main() {
  const supervisor = new Supervisor({
    programs: platformPrograms({
      env: process.env,
      bundledPostgres: process.argv.includes("--postgres"),
    }),
  });
  for (const name of ["SIGTERM", "SIGINT"]) {
    process.on(name, () => supervisor.stop().then(() => process.exit(0)));
  }
  supervisor.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
