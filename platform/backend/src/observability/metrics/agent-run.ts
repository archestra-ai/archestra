/**
 * Prometheus metric for unique agent runs.
 * A run is identified by the X-Archestra-Run-Id header.
 *
 * Join with llm_cost_total to compute average cost per run:
 * sum(llm_cost_total) by (agent_id) / sum(agent_runs_total) by (agent_id)
 */

import client from "prom-client";
import logger from "@/logging";
import type { GatewayAgent } from "@/types";
import { sanitizeLabelKey } from "./utils";

let agentRunsTotal: client.Counter<string>;
let currentLabelKeys: string[] = [];

/**
 * Initialize agent run metrics with dynamic label keys.
 * @param labelKeys Array of agent label keys to include as metric labels
 */
export function initializeAgentRunMetrics(labelKeys: string[]): void {
  const nextLabelKeys = labelKeys.map(sanitizeLabelKey).sort();
  const labelKeysChanged =
    JSON.stringify(nextLabelKeys) !== JSON.stringify(currentLabelKeys);

  if (!labelKeysChanged && agentRunsTotal) {
    return;
  }

  currentLabelKeys = nextLabelKeys;

  try {
    if (agentRunsTotal) {
      client.register.removeSingleMetric("agent_runs_total");
    }
  } catch (_error) {
    // Ignore errors if metric doesn't exist
  }

  const baseLabelNames = [
    "external_agent_id",
    "agent_id",
    "agent_name",
    "agent_type",
  ];

  agentRunsTotal = new client.Counter({
    name: "agent_runs_total",
    help: "Total unique agent runs",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
  });

  logger.info(
    `Agent run metrics initialized with ${nextLabelKeys.length} label keys: ${nextLabelKeys.join(", ")}`,
  );
}

/**
 * Reports a unique agent run.
 * Caller is responsible for deduplication (checking DB).
 */
export function reportAgentRun(params: {
  runId: string;
  profile: GatewayAgent;
  externalAgentId?: string;
}): void {
  if (!agentRunsTotal) {
    logger.warn("Agent run metrics not initialized, skipping run reporting");
    return;
  }

  const labels: Record<string, string> = {
    external_agent_id: params.externalAgentId ?? "",
    agent_id: params.profile.id,
    agent_name: params.profile.name,
    agent_type: params.profile.agentType ?? "",
  };

  for (const labelKey of currentLabelKeys) {
    const agentLabel = params.profile.labels?.find(
      (l) => sanitizeLabelKey(l.key) === labelKey,
    );
    labels[labelKey] = agentLabel?.value ?? "";
  }

  agentRunsTotal.inc(labels);
}
