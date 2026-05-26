/**
 * Prometheus metrics for the sandboxed code-execution runtime.
 *
 * Run throughput:
 * rate(code_runtime_runs_total[5m])
 *
 * Average run duration:
 * rate(code_runtime_run_duration_seconds_sum[5m]) / rate(code_runtime_run_duration_seconds_count[5m])
 */

import client from "prom-client";
import logger from "@/logging";

type RunStatus = "ok" | "script_error" | "runtime_error" | "timeout";

let codeRuntimeRunsTotal: client.Counter<string>;
let codeRuntimeRunDuration: client.Histogram<string>;

let initialized = false;

export function initializeCodeRuntimeMetrics(): void {
  if (initialized) return;

  codeRuntimeRunsTotal = new client.Counter({
    name: "code_runtime_runs_total",
    help: "Total code-runtime script executions",
    labelNames: ["status"],
  });

  codeRuntimeRunDuration = new client.Histogram({
    name: "code_runtime_run_duration_seconds",
    help: "Code-runtime script execution duration in seconds",
    labelNames: ["status"],
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  });

  initialized = true;
  logger.info("Code runtime metrics initialized");
}

export function reportRun(status: RunStatus, durationSeconds: number): void {
  if (!initialized) return;
  codeRuntimeRunsTotal.inc({ status });
  codeRuntimeRunDuration.observe({ status }, durationSeconds);
}
