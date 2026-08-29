/**
 * Prometheus metrics for Runners.
 *
 * A runner holds a pod for as long as its session lives, so the fleet-level
 * questions are how many are alive right now, how they end, and how long
 * provisioning takes:
 *
 *   sum by (outcome) (increase(runner_terminations_total[1d]))
 *   histogram_quantile(0.95, sum by (le) (rate(runner_provision_duration_seconds_bucket[1h])))
 *
 * Labelled only by closed sets — never by runner id, agent id, image or user,
 * which are unbounded values that would explode series cardinality. Per-runner
 * detail lives in the database and is served by the runner routes.
 */

import client from "prom-client";
import logger from "@/logging";

/** Why a runner stopped. `failed` covers both provisioning and session faults. */
type RunnerTerminationOutcome =
  | "completed"
  | "failed"
  | "stopped_by_user"
  | "expired_ttl"
  | "expired_idle";
type RunnerCompletionInterface = "chatops" | "email";
type RunnerCompletionDeliveryOutcome = "success" | "failed";

let runnerStartsTotal: client.Counter<string>;
let runnerTerminationsTotal: client.Counter<string>;
let runnerProvisionDurationSeconds: client.Histogram<string>;
let runnerSteersTotal: client.Counter<string>;
let runnerCompletionDeliveriesTotal: client.Counter<string>;

let initialized = false;

export function initializeRunnerMetrics(): void {
  if (initialized) return;
  initialized = true;

  runnerStartsTotal = new client.Counter({
    name: "runner_starts_total",
    help: "Total runners started",
  });

  runnerTerminationsTotal = new client.Counter({
    name: "runner_terminations_total",
    help: "Total runners that reached a terminal state, by outcome (completed, failed, stopped_by_user, expired_ttl, expired_idle)",
    labelNames: ["outcome"],
  });

  runnerProvisionDurationSeconds = new client.Histogram({
    name: "runner_provision_duration_seconds",
    help: "Time from a runner being created to its session reporting running",
    // A pod pulling a large agent image is the slow case worth seeing, so the
    // buckets run well past the fast path rather than clipping at a minute.
    buckets: [5, 15, 30, 60, 120, 300, 600],
  });

  runnerSteersTotal = new client.Counter({
    name: "runner_steers_total",
    help: "Total steer messages delivered into live sessions, by delivery mode (pipe, tmux_keys)",
    labelNames: ["steer_mode"],
  });

  runnerCompletionDeliveriesTotal = new client.Counter({
    name: "runner_completion_deliveries_total",
    help: "Total terminal Agent execution results delivered to an external interface",
    labelNames: ["interface", "outcome"],
  });

  logger.info("Runner metrics initialized");
}

export function reportRunnerStarted(): void {
  runnerStartsTotal?.inc();
}

export function reportRunnerTerminated(
  outcome: RunnerTerminationOutcome,
): void {
  runnerTerminationsTotal?.inc({ outcome });
}

export function reportRunnerProvisioned(seconds: number): void {
  if (!runnerProvisionDurationSeconds || seconds < 0) return;
  runnerProvisionDurationSeconds.observe(seconds);
}

export function reportRunnerSteer(steerMode: string): void {
  runnerSteersTotal?.inc({ steer_mode: steerMode });
}

export function reportRunnerCompletionDelivery(
  completionInterface: RunnerCompletionInterface,
  outcome: RunnerCompletionDeliveryOutcome,
): void {
  runnerCompletionDeliveriesTotal?.inc({
    interface: completionInterface,
    outcome,
  });
}
