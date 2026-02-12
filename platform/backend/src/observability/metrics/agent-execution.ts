/**
 * Prometheus metric for unique agent executions.
 * An "execution" is identified by the X-Archestra-Execution-Id header.
 *
 * Join with llm_cost_total to compute average cost per execution:
 * sum(llm_cost_total) by (agent_id) / sum(agent_executions_total) by (agent_id)
 */

import client from "prom-client";
import logger from "@/logging";
import type { Agent } from "@/types";
import { sanitizeLabelKey } from "./utils";

let agentExecutionsTotal: client.Counter<string>;
let currentLabelKeys: string[] = [];

/**
 * Initialize agent execution metrics with dynamic label keys.
 * @param labelKeys Array of agent label keys to include as metric labels
 */
export function initializeAgentExecutionMetrics(labelKeys: string[]): void {
  const nextLabelKeys = labelKeys.map(sanitizeLabelKey).sort();
  const labelKeysChanged =
    JSON.stringify(nextLabelKeys) !== JSON.stringify(currentLabelKeys);

  if (!labelKeysChanged && agentExecutionsTotal) {
    return;
  }

  currentLabelKeys = nextLabelKeys;

  try {
    if (agentExecutionsTotal) {
      client.register.removeSingleMetric("agent_executions_total");
    }
  } catch (_error) {
    // Ignore errors if metric doesn't exist
  }

  const baseLabelNames = ["agent_id", "profile_id", "profile_name"];

  agentExecutionsTotal = new client.Counter({
    name: "agent_executions_total",
    help: "Total unique agent executions",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
  });

  logger.info(
    `Agent execution metrics initialized with ${nextLabelKeys.length} label keys: ${nextLabelKeys.join(", ")}`,
  );
}

/**
 * Reports a unique agent execution.
 * Caller is responsible for deduplication (checking DB).
 */
export function reportAgentExecution(params: {
  executionId: string;
  profile: Agent;
  externalAgentId?: string;
}): void {
  if (!agentExecutionsTotal) {
    logger.warn(
      "Agent execution metrics not initialized, skipping execution reporting",
    );
    return;
  }

  const labels: Record<string, string> = {
    agent_id: params.externalAgentId ?? "",
    profile_id: params.profile.id,
    profile_name: params.profile.name,
  };

  for (const labelKey of currentLabelKeys) {
    const agentLabel = params.profile.labels?.find(
      (l) => sanitizeLabelKey(l.key) === labelKey,
    );
    labels[labelKey] = agentLabel?.value ?? "";
  }

  agentExecutionsTotal.inc(labels);
}
