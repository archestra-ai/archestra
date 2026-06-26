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
 * Short, low-cardinality `code` label for `sandbox_runtime_errors_total`.
 * Distinguishes a genuine engine outage (`engine_unreachable`) from a per-call
 * `internal` failure, so a `runtime_error` command spike becomes diagnosable.
 */
type SandboxRuntimeErrorCode = "engine_unreachable" | "internal";

/**
 * The set of `SandboxRuntimeStatus` values the gauge tracks. Kept local to the
 * metrics module (rather than imported) so the gauge can emit a 0 for every
 * non-current state without coupling to the runtime service's enum shape.
 */
const SANDBOX_RUNTIME_STATUSES = [
  "disabled",
  "initializing",
  "ready",
  "error",
  "stopped",
] as const;
type SandboxRuntimeStatusLabel = (typeof SANDBOX_RUNTIME_STATUSES)[number];

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
let sandboxRuntimeErrorsTotal: client.Counter<string>;
let sandboxRuntimeStatus: client.Gauge<string>;

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

  sandboxRuntimeErrorsTotal = new client.Counter({
    name: "sandbox_runtime_errors_total",
    help: "Total sandbox runtime errors by code (engine_unreachable distinguishes a genuine engine outage from a per-call internal failure)",
    labelNames: ["code"],
  });

  sandboxRuntimeStatus = new client.Gauge({
    name: "sandbox_runtime_status",
    help: "Current sandbox runtime status (1 = active status)",
    labelNames: ["status"],
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

/**
 * Increment the labeled runtime-error counter at the normalizeError choke point.
 * `engine_unreachable` flags a genuine engine outage; `internal` is a per-call
 * failure that doesn't imply the engine is gone.
 */
export function reportRuntimeError(params: {
  code: SandboxRuntimeErrorCode;
}): void {
  if (!initialized) return;
  sandboxRuntimeErrorsTotal.inc({ code: params.code });
}

/**
 * Set the runtime-status gauge to 1 for the current status and 0 for all other
 * statuses, mirroring `mcp_server_deployment_status`. Call on every transition.
 */
export function reportRuntimeStatus(params: {
  status: SandboxRuntimeStatusLabel;
}): void {
  if (!initialized) return;
  for (const status of SANDBOX_RUNTIME_STATUSES) {
    sandboxRuntimeStatus.set({ status }, status === params.status ? 1 : 0);
  }
}
