import AgentLabelModel from "@/models/agent-label";
import * as metrics from "./metrics";

export async function initializeObservabilityMetrics(params?: {
  includeMcpMetrics?: boolean;
  includeAgentExecutionMetrics?: boolean;
}): Promise<string[]> {
  const { includeMcpMetrics = true, includeAgentExecutionMetrics = true } =
    params ?? {};
  const labelKeys = await AgentLabelModel.getAllKeys();

  metrics.llm.initializeMetrics(labelKeys);

  if (includeMcpMetrics) {
    metrics.mcp.initializeMcpMetrics(labelKeys);
  }

  if (includeAgentExecutionMetrics) {
    metrics.agentExecution.initializeAgentExecutionMetrics(labelKeys);
  }

  metrics.rag.initializeRagMetrics();
  metrics.taskQueue.initializeTaskQueueMetrics();

  return labelKeys;
}

export { metrics };
export * as tracing from "./tracing";
