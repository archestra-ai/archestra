/**
 * Prometheus metrics for scheduled trigger (scheduled task) runs.
 *
 * Successful runs per agent:
 * sum by (agent_name) (rate(schedule_trigger_runs_total{status="success"}[5m]))
 *
 * Failed runs per agent:
 * sum by (agent_name) (rate(schedule_trigger_runs_total{status="failed"}[5m]))
 *
 * User-stopped runs are counted with status="cancelled".
 */

import client from "prom-client";
import logger from "@/logging";
import type { ScheduleTriggerRunStatus } from "@/types/schedule-trigger";

let scheduleTriggerRunsTotal: client.Counter<string>;

let initialized = false;

export function initializeScheduleTriggerMetrics(): void {
  if (initialized) return;
  initialized = true;

  scheduleTriggerRunsTotal = new client.Counter({
    name: "schedule_trigger_runs_total",
    help: "Total scheduled trigger runs by agent and outcome",
    labelNames: ["agent_name", "status"],
  });

  logger.info("Schedule trigger metrics initialized");
}

export function reportScheduleTriggerRun(
  agentName: string,
  status: Exclude<ScheduleTriggerRunStatus, "running">,
): void {
  if (!scheduleTriggerRunsTotal) return;
  scheduleTriggerRunsTotal.inc({ agent_name: agentName, status });
}
