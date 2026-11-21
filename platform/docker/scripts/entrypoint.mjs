// The entrypoint of the Kubernetes image (archestra/platform:<version>-slim),
// which has no shell. The docker run image keeps docker-entrypoint.sh for its
// quickstart cluster and bundled PostgreSQL. This one:
// - loads or generates the persistent auth secret when none is set
// - refuses the quickstart and a missing database, which need the docker run
//   image
// - exports the resolved DATABASE_URL and a validated keep-alive timeout for
//   the processes it starts
// - runs supervisor.mjs's programs in this process: the backend, the
//   frontend and the startup banner; SIGTERM or SIGINT stops them and exits 0

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorStopSeconds } from "./shutdown-budget.mjs";
import { Supervisor, platformPrograms } from "./supervisor.mjs";

// ===
// Public interface
// ===

/**
 * The environment the supervisor's programs get, or the error that stops the
 * container. `dataDir` holds the generated auth secret.
 */
export function prepare(input, { dataDir = "/app/data" } = {}) {
  const env = { ...input };
  const messages = [];
  const fail = (...lines) => ({ error: lines.join("\n"), env, messages });
  const version = env.ARCHESTRA_VERSION || "<version>";

  if (env.ARCHESTRA_QUICKSTART === "true") {
    return fail(
      "ERROR: This is the Kubernetes image (-slim), which has no quickstart.",
      `Use archestra/platform:${version}.`,
    );
  }
  const databaseUrl = env.ARCHESTRA_DATABASE_URL || env.DATABASE_URL;
  if (!databaseUrl) {
    return fail(
      "ERROR: This is the Kubernetes image (-slim), which has no bundled PostgreSQL.",
      `Set ARCHESTRA_DATABASE_URL to your PostgreSQL database, or use archestra/platform:${version}.`,
    );
  }
  // Every process gets the environment unchanged, so every legal URL
  // character survives verbatim.
  env.DATABASE_URL = databaseUrl;
  messages.push("Using external PostgreSQL database");

  if (!env.ARCHESTRA_AUTH_SECRET) {
    const secretFile = path.join(dataDir, ".auth_secret");
    if (existsSync(secretFile)) {
      env.ARCHESTRA_AUTH_SECRET = readFileSync(secretFile, "utf8").trim();
      messages.push(`Loaded existing ARCHESTRA_AUTH_SECRET from ${secretFile}`);
    } else {
      try {
        mkdirSync(dataDir, { recursive: true });
        env.ARCHESTRA_AUTH_SECRET = randomAlphanumeric(64);
        writeFileSync(secretFile, `${env.ARCHESTRA_AUTH_SECRET}\n`, { mode: 0o600 });
        chmodSync(secretFile, 0o600);
      } catch {
        return fail(
          `ERROR: ARCHESTRA_AUTH_SECRET is not set, and ${dataDir} is not writable by user ${process.getuid?.()} to keep a generated one.`,
          `Set ARCHESTRA_AUTH_SECRET, or mount a volume at ${dataDir} that this user can write.`,
        );
      }
      messages.push(`Generated and saved new ARCHESTRA_AUTH_SECRET to ${secretFile}`);
    }
  }

  // The backend falls back to the default on a bad value itself, but the
  // Next.js server gets the raw string as KEEP_ALIVE_TIMEOUT and treats an
  // unparsable one as unset, dropping to Node's 5s. Validating once keeps both
  // servers on the same window.
  const keepAlive = env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS;
  if (keepAlive === undefined || keepAlive === "") {
    env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS = String(KEEP_ALIVE_DEFAULT_MS);
  } else if (!/^\d+$/.test(keepAlive) || !(Number(keepAlive) > 0) || !Number.isSafeInteger(Number(keepAlive))) {
    messages.push(
      // The value itself is not echoed: environment values stay out of logs.
      `WARNING: ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS must be a positive integer of milliseconds, using default ${KEEP_ALIVE_DEFAULT_MS}ms`,
    );
    env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS = String(KEEP_ALIVE_DEFAULT_MS);
  }

  try {
    env.ARCHESTRA_SERVER_SUPERVISOR_STOP_SECONDS = String(supervisorStopSeconds(env));
  } catch (error) {
    return fail(`ERROR: ${error.message}`);
  }
  return { env, messages };
}

// ===
// Internal helpers
// ===

const KEEP_ALIVE_DEFAULT_MS = 620_000;
const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomAlphanumeric(length) {
  let result = "";
  while (result.length < length) {
    for (const byte of randomBytes(length)) {
      // 248 is the largest multiple of 62 below 256: no modulo bias.
      if (byte < 248 && result.length < length) result += ALPHANUMERIC[byte % 62];
    }
  }
  return result;
}

function main() {
  const { env, error, messages } = prepare(process.env);
  for (const message of messages) {
    (message.startsWith("WARNING") ? console.error : console.log)(message);
  }
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const supervisor = new Supervisor({
    programs: platformPrograms({ env, bundledPostgres: false }),
    env,
  });
  for (const name of ["SIGTERM", "SIGINT"]) {
    process.on(name, () => {
      console.log("Shutting down...");
      supervisor.stop().then(() => process.exit(0));
    });
  }
  supervisor.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
