/**
 * Prometheus metrics for MCP tool calls.
 * Tracks tool call execution duration, total calls, and error rates.
 *
 * To calculate tool calls per second, use the rate() function in Prometheus:
 * rate(mcp_tool_calls_total{agent_name="my-agent"}[5m])
 */

import client from "prom-client";
import logger from "@/logging";
import type { AgentType } from "@/types";
import { getExemplarLabels, sanitizeLabelKey } from "./utils";

let mcpToolCallDuration: client.Histogram<string>;
let mcpToolCallsTotal: client.Counter<string>;
let mcpRequestSizeBytes: client.Histogram<string>;
let mcpResponseSizeBytes: client.Histogram<string>;

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
