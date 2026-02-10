/**
 * Prometheus metrics for MCP tool calls.
 * Tracks tool call execution duration, total calls, and error rates.
 *
 * To calculate tool calls per second, use the rate() function in Prometheus:
 * rate(mcp_tool_calls_total{profile_name="my-profile"}[5m])
 */

import client from "prom-client";
import logger from "@/logging";
import { sanitizeLabelKey } from "./utils";

let mcpToolCallDuration: client.Histogram<string>;
let mcpToolCallsTotal: client.Counter<string>;

// Store current label keys for comparison
let currentLabelKeys: string[] = [];

/**
 * Initialize MCP metrics with dynamic profile label keys
 * @param labelKeys Array of profile label keys to include as metric labels
 */
export function initializeMcpMetrics(labelKeys: string[]): void {
  const nextLabelKeys = labelKeys.map(sanitizeLabelKey).sort();
  const labelKeysChanged =
    JSON.stringify(nextLabelKeys) !== JSON.stringify(currentLabelKeys);

  if (!labelKeysChanged && mcpToolCallDuration && mcpToolCallsTotal) {
    return;
  }

  currentLabelKeys = nextLabelKeys;

  // Unregister old metrics if they exist
  try {
    if (mcpToolCallDuration) {
      client.register.removeSingleMetric("mcp_tool_call_duration_seconds");
    }
    if (mcpToolCallsTotal) {
      client.register.removeSingleMetric("mcp_tool_calls_total");
    }
  } catch (_error) {
    // Ignore errors if metrics don't exist
  }

  const baseLabelNames = [
    "profile_name",
    "mcp_server_name",
    "tool_name",
    "status",
  ];

  mcpToolCallDuration = new client.Histogram({
    name: "mcp_tool_call_duration_seconds",
    help: "MCP tool call execution duration in seconds",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  });

  mcpToolCallsTotal = new client.Counter({
    name: "mcp_tool_calls_total",
    help: "Total MCP tool calls",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
  });

  logger.info(
    `MCP metrics initialized with ${nextLabelKeys.length} profile label keys: ${nextLabelKeys.join(", ")}`,
  );
}

/**
 * Build metric labels for an MCP tool call
 */
function buildMetricLabels(params: {
  profileName: string;
  mcpServerName: string;
  toolName: string;
  status: "success" | "error";
  profileLabels?: Array<{ key: string; value: string }>;
}): Record<string, string> {
  const labels: Record<string, string> = {
    profile_name: params.profileName,
    mcp_server_name: params.mcpServerName,
    tool_name: params.toolName,
    status: params.status,
  };

  for (const labelKey of currentLabelKeys) {
    const profileLabel = params.profileLabels?.find(
      (l) => sanitizeLabelKey(l.key) === labelKey,
    );
    labels[labelKey] = profileLabel?.value ?? "";
  }

  return labels;
}

/**
 * Reports an MCP tool call with duration
 */
export function reportMcpToolCall(params: {
  profileName: string;
  mcpServerName: string;
  toolName: string;
  durationSeconds: number;
  isError: boolean;
  profileLabels?: Array<{ key: string; value: string }>;
}): void {
  if (!mcpToolCallDuration || !mcpToolCallsTotal) {
    logger.warn("MCP metrics not initialized, skipping tool call reporting");
    return;
  }

  const status = params.isError ? "error" : "success";
  const labels = buildMetricLabels({
    profileName: params.profileName,
    mcpServerName: params.mcpServerName,
    toolName: params.toolName,
    status,
    profileLabels: params.profileLabels,
  });

  mcpToolCallsTotal.inc(labels);
  if (params.durationSeconds > 0) {
    mcpToolCallDuration.observe(labels, params.durationSeconds);
  }
}
