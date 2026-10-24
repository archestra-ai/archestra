import cluster from "node:cluster";
import fs from "node:fs";
import path from "node:path";

// Manual configuration experiment: real web processes, one shared HTTP port,
// and the same total database-connection budget as the single-process run.
const [entry, count, metrics, readyFile] = process.argv.slice(2);
if (
  !path.isAbsolute(entry ?? "") ||
  !/^[1-4]$/.test(count ?? "") ||
  !/^\d+$/.test(metrics ?? "") ||
  !path.isAbsolute(readyFile ?? "")
)
  throw Error(
    "Expected absolute entry, 1–4 workers, ports and absolute readiness file",
  );
const workers = Number(count);
let stopping = false;
let exitCode = 0;
const listening = new Set();
let started = 0;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  process.exitCode = code;
  for (const worker of Object.values(cluster.workers)) worker?.kill("SIGTERM");
  // Only disposable synthetic stacks use this supervisor. Bound teardown so
  // a failed child cannot leave its siblings running after the launcher exits.
  setTimeout(() => {
    for (const worker of Object.values(cluster.workers))
      worker?.kill("SIGKILL");
  }, 8000).unref();
};
cluster.setupPrimary({ exec: entry, execArgv: [] });
cluster.on("message", (worker, message) => {
  if (message?.type !== "archestra.web.ready" || listening.has(worker.id))
    return;
  listening.add(worker.id);
  if (listening.size === workers)
    fs.writeFileSync(readyFile, JSON.stringify({ workers, pid: process.pid }));
  else if (!stopping) startNext();
});
cluster.on("exit", (_worker, code, signal) => {
  if (!stopping) {
    console.error(`Benchmark worker exited unexpectedly: ${code ?? signal}`);
    stop(1);
  }
  if (Object.keys(cluster.workers).length === 0) process.exit(exitCode);
});
process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));
// Let one web process bootstrap an empty database before the next starts.
// Measured load begins only after every worker has opened its HTTP listener.
function startNext() {
  const index = started++;
  cluster.fork({
    ...process.env,
    ARCHESTRA_DATABASE_POOL_MAX: String(Math.floor(20 / workers)),
    ARCHESTRA_METRICS_PORT: String(Number(metrics) + index * 100),
  });
}
startNext();
