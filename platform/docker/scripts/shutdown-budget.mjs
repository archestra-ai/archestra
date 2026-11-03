// Used before supervisord starts; keep the backend's derived deadline below it.
function seconds(name, fallback, minimum = 1) {
  const raw = process.env[name];
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
const drain = seconds("ARCHESTRA_SERVER_REQUEST_DRAIN_SECONDS", 60);
const cleanup = seconds("ARCHESTRA_SERVER_SHUTDOWN_CLEANUP_SECONDS", 20, 5);
const worker = seconds(
  "ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS",
  30,
);
console.log(Math.max(drain, worker) + cleanup + 10);
