/**
 * Prometheus metrics for Agent Runtime.
 *
 * A dedicated runtime holds a pod for as long as its run lives, so the fleet-level
 * questions are how many are alive right now, how they end, and how long
 * provisioning takes:
 *
 *   sum by (outcome) (increase(agent_runtime_runs_terminated_total[1d]))
 *   histogram_quantile(0.95, sum by (le) (rate(agent_runtime_provision_duration_seconds_bucket[1h])))
 *
 * Labelled only by closed sets — never by run ID, agent ID, image, or user,
 * which are unbounded values that would explode series cardinality. Per-run
 * detail lives in the database and is served by the Agent Runtime routes.
 */

import client from "prom-client";
import logger from "@/logging";

/** Why an Agent Runtime run stopped. `failed` covers provisioning and session faults. */
type AgentRunTerminationOutcome =
  | "completed"
  | "failed"
  | "stopped_by_user"
  | "expired_ttl"
  | "expired_idle";
type AgentRunCompletionInterface = "chatops" | "email";
type AgentRunCompletionDeliveryOutcome = "success" | "failed";

let agentRunStartsTotal: client.Counter<string>;
let agentRunTerminationsTotal: client.Counter<string>;
let agentRuntimeProvisionDurationSeconds: client.Histogram<string>;
let agentRuntimeSteersTotal: client.Counter<string>;
let agentRuntimeCompletionDeliveriesTotal: client.Counter<string>;

let initialized = false;

export function initializeAgentRuntimeMetrics(): void {
  if (initialized) return;
  initialized = true;

  agentRunStartsTotal = new client.Counter({
    name: "agent_runtime_runs_started_total",
    help: "Total Agent Runtime runs started",
  });

  agentRunTerminationsTotal = new client.Counter({
    name: "agent_runtime_runs_terminated_total",
    help: "Total Agent Runtime runs that reached a terminal state, by outcome (completed, failed, stopped_by_user, expired_ttl, expired_idle)",
    labelNames: ["outcome"],
  });

  agentRuntimeProvisionDurationSeconds = new client.Histogram({
    name: "agent_runtime_provision_duration_seconds",
    help: "Time from an Agent Runtime run being created to reporting running",
    // A pod pulling a large agent image is the slow case worth seeing, so the
    // buckets run well past the fast path rather than clipping at a minute.
    buckets: [5, 15, 30, 60, 120, 300, 600],
  });

  agentRuntimeSteersTotal = new client.Counter({
    name: "agent_runtime_steers_total",
    help: "Total steer messages delivered into live sessions, by delivery mode (pipe, tmux_keys)",
    labelNames: ["steer_mode"],
  });

  agentRuntimeCompletionDeliveriesTotal = new client.Counter({
    name: "agent_runtime_completion_deliveries_total",
    help: "Total terminal Agent Runtime run results delivered to an external interface",
    labelNames: ["interface", "outcome"],
  });

  logger.info("Agent Runtime metrics initialized");
}

export function reportAgentRuntimeStarted(): void {
  agentRunStartsTotal?.inc();
}

export function reportAgentRuntimeTerminated(
  outcome: AgentRunTerminationOutcome,
): void {
  agentRunTerminationsTotal?.inc({ outcome });
}

export function reportAgentRuntimeProvisioned(seconds: number): void {
  if (!agentRuntimeProvisionDurationSeconds || seconds < 0) return;
  agentRuntimeProvisionDurationSeconds.observe(seconds);
}

export function reportAgentRuntimeSteer(steerMode: string): void {
  agentRuntimeSteersTotal?.inc({ steer_mode: steerMode });
}

export function reportAgentRunCompletionDelivery(
  completionInterface: AgentRunCompletionInterface,
  outcome: AgentRunCompletionDeliveryOutcome,
): void {
  agentRuntimeCompletionDeliveriesTotal?.inc({
    interface: completionInterface,
    outcome,
  });
}
