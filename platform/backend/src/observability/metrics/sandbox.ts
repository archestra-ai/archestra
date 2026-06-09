/**
 * Prometheus metrics for the code-execution sandbox (`run_command`).
 *
 * Command throughput:
 * rate(sandbox_commands_total[5m])
 *
 * Timeout rate:
 * rate(sandbox_commands_total{status="timeout"}[5m])
 *
 * Average command duration:
 * rate(sandbox_command_duration_seconds_sum[5m]) / rate(sandbox_command_duration_seconds_count[5m])
 */

import client from "prom-client";
import logger from "@/logging";

/**
 * - `ok` — command exited 0
 * - `script_error` — command ran but exited non-zero
 * - `timeout` — command exceeded its timeout
 * - `runtime_error` — the engine call itself failed (unreachable / internal)
 */
type SandboxCommandStatus = "ok" | "script_error" | "timeout" | "runtime_error";

/**
 * Classify a completed command execution. Timeout takes precedence over exit
 * code (a timed-out command may also report a non-zero exit). The thrown
 * engine-failure case (`runtime_error`) is handled by the caller's catch.
 */
export function classifyCommandStatus(executed: {
  timedOut: boolean;
  exitCode: number;
}): SandboxCommandStatus {
  if (executed.timedOut) return "timeout";
  return executed.exitCode === 0 ? "ok" : "script_error";
}

let sandboxCommandsTotal: client.Counter<string>;
let sandboxCommandDuration: client.Histogram<string>;

let initialized = false;

export function initializeSandboxMetrics(): void {
  if (initialized) return;

  sandboxCommandsTotal = new client.Counter({
    name: "sandbox_commands_total",
    help: "Total sandbox commands executed via run_command",
    labelNames: ["status"],
  });

  sandboxCommandDuration = new client.Histogram({
    name: "sandbox_command_duration_seconds",
    help: "Sandbox command execution duration in seconds",
    labelNames: ["status"],
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  });

  initialized = true;
  logger.info("Sandbox metrics initialized");
}

export function reportCommand(params: {
  status: SandboxCommandStatus;
  durationSeconds: number;
}): void {
  if (!initialized) return;
  sandboxCommandsTotal.inc({ status: params.status });
  sandboxCommandDuration.observe(
    { status: params.status },
    params.durationSeconds,
  );
}
