// The backend's stop timeout in supervisor.mjs: the longer of the request
// drain and the knowledge-base task drain, plus the shutdown cleanup and ten
// seconds. Keep the backend's derived deadline below it. entrypoint.mjs
// imports it; run as a script, it prints the number.

import { fileURLToPath } from "node:url";

/** Seconds; throws on an invalid setting. */
export function supervisorStopSeconds(env) {
  const drain = seconds(env, "ARCHESTRA_SERVER_REQUEST_DRAIN_SECONDS", 60);
  const cleanup = seconds(env, "ARCHESTRA_SERVER_SHUTDOWN_CLEANUP_SECONDS", 20, 5);
  const worker = seconds(
    env,
    "ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS",
    30,
  );
  return Math.max(drain, worker) + cleanup + 10;
}

function seconds(env, name, fallback, minimum = 1) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > 86400
  ) {
    throw new Error(
      `${name} must be integer seconds between ${minimum} and 86400`,
    );
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(supervisorStopSeconds(process.env));
}
