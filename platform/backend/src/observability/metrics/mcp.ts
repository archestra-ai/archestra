/**
 * Prometheus metrics for MCP tool calls and deployment status.
 * Tracks tool call execution duration, total calls, error rates,
 * and K8s deployment states for self-hosted MCP servers.
 *
 * To calculate tool calls per second, use the rate() function in Prometheus:
 * rate(mcp_tool_calls_total{agent_name="my-agent"}[5m])
 */

import { MCP_DEPLOYMENT_STATES } from "@shared";
import client from "prom-client";
import logger from "@/logging";
import type { AgentType } from "@/types";
import { getExemplarLabels, sanitizeLabelKey } from "./utils";

let mcpToolCallDuration: client.Histogram<string>;
let mcpToolCallsTotal: client.Counter<string>;
let mcpRequestSizeBytes: client.Histogram<string>;
let mcpResponseSizeBytes: client.Histogram<string>;

// Deployment status gauge — one series per (server_name, state) combination.
// Each server has exactly one active state at a time (value=1), with all other
// states at 0. This enables queries like:
//   count(mcp_server_deployment_status{state="running"} == 1)
let mcpServerDeploymentStatus: client.Gauge<string> | undefined;

// Store current label keys for comparison
let currentLabelKeys: string[] = [];

/**
 * Initialize MCP metrics with dynamic agent label keys
 * @param labelKeys Array of agent label keys to include as metric labels
 */
export function initializeMcpMetrics(labelKeys: string[]): void {
  const nextLabelKeys = labelKeys.map(sanitizeLabelKey).sort();
  const labelKeysChanged =
    JSON.stringify(nextLabelKeys) !== JSON.stringify(currentLabelKeys);

  if (
    !labelKeysChanged &&
    mcpToolCallDuration &&
    mcpToolCallsTotal &&
    mcpRequestSizeBytes &&
    mcpResponseSizeBytes
  ) {
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
    if (mcpRequestSizeBytes) {
      client.register.removeSingleMetric("mcp_request_size_bytes");
    }
    if (mcpResponseSizeBytes) {
      client.register.removeSingleMetric("mcp_response_size_bytes");
    }
  } catch (_error) {
    // Ignore errors if metrics don't exist
  }

  const baseLabelNames = [
    "agent_id",
    "agent_name",
    "agent_type",
    "mcp_server_name",
    "tool_name",
    "status",
  ];

  mcpToolCallDuration = new client.Histogram({
    name: "mcp_tool_call_duration_seconds",
    help: "MCP tool call execution duration in seconds",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    enableExemplars: true,
  });

  mcpToolCallsTotal = new client.Counter({
    name: "mcp_tool_calls_total",
    help: "Total MCP tool calls",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    enableExemplars: true,
  });

  mcpRequestSizeBytes = new client.Histogram({
    name: "mcp_request_size_bytes",
    help: "MCP tool call request payload size in bytes",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
    enableExemplars: true,
  });

  mcpResponseSizeBytes = new client.Histogram({
    name: "mcp_response_size_bytes",
    help: "MCP tool call response payload size in bytes",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000],
    enableExemplars: true,
  });

  logger.info(
    `MCP metrics initialized with ${nextLabelKeys.length} agent label keys: ${nextLabelKeys.join(", ")}`,
  );
}

/**
 * Build metric labels for an MCP tool call
 */
function buildMetricLabels(params: {
  agentId: string;
  agentName: string;
  agentType: AgentType | null;
  mcpServerName: string;
  toolName: string;
  status: "success" | "error";
  agentLabels?: Array<{ key: string; value: string }>;
}): Record<string, string> {
  const labels: Record<string, string> = {
    agent_id: params.agentId,
    agent_name: params.agentName,
    agent_type: params.agentType ?? "",
    mcp_server_name: params.mcpServerName,
    tool_name: params.toolName,
    status: params.status,
  };

  for (const labelKey of currentLabelKeys) {
    const agentLabel = params.agentLabels?.find(
      (l) => sanitizeLabelKey(l.key) === labelKey,
    );
    labels[labelKey] = agentLabel?.value ?? "";
  }

  return labels;
}

/**
 * Reports an MCP tool call with duration
 */
export function reportMcpToolCall(params: {
  agentId: string;
  agentName: string;
  agentType: AgentType | null;
  mcpServerName: string;
  toolName: string;
  durationSeconds: number;
  isError: boolean;
  agentLabels?: Array<{ key: string; value: string }>;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
}): void {
  if (!mcpToolCallDuration || !mcpToolCallsTotal) {
    logger.warn("MCP metrics not initialized, skipping tool call reporting");
    return;
  }

  const status = params.isError ? "error" : "success";
  const labels = buildMetricLabels({
    agentId: params.agentId,
    agentName: params.agentName,
    agentType: params.agentType,
    mcpServerName: params.mcpServerName,
    toolName: params.toolName,
    status,
    agentLabels: params.agentLabels,
  });

  const exemplarLabels = getExemplarLabels();

  mcpToolCallsTotal.inc({ labels, value: 1, exemplarLabels });
  if (params.durationSeconds > 0) {
    mcpToolCallDuration.observe({
      labels,
      value: params.durationSeconds,
      exemplarLabels,
    });
  }
  if (params.requestSizeBytes != null && params.requestSizeBytes > 0) {
    mcpRequestSizeBytes.observe({
      labels,
      value: params.requestSizeBytes,
      exemplarLabels,
    });
  }
  if (params.responseSizeBytes != null && params.responseSizeBytes > 0) {
    mcpResponseSizeBytes.observe({
      labels,
      value: params.responseSizeBytes,
      exemplarLabels,
    });
  }
}

/**
 * Update the mcp_server_deployment_status gauge from a map of server statuses.
 * Each server gets value=1 for its current state and value=0 for all other states.
 * Stale servers (present in the gauge but absent from `statuses`) are removed.
 */
export function reportMcpDeploymentStatuses(
  statuses: Record<string, { serverName: string; state: string }>,
): void {
  if (!mcpServerDeploymentStatus) {
    mcpServerDeploymentStatus = new client.Gauge({
      name: "mcp_server_deployment_status",
      help: "Current deployment state of self-hosted MCP servers (1 = active state)",
      labelNames: ["server_name", "state"],
    });
  }

  // Reset gauge to remove stale series from servers that no longer exist
  mcpServerDeploymentStatus.reset();

  for (const { serverName, state } of Object.values(statuses)) {
    for (const s of MCP_DEPLOYMENT_STATES) {
      mcpServerDeploymentStatus.set(
        { server_name: serverName, state: s },
        s === state ? 1 : 0,
      );
    }
  }
}
