import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  register,
} from "prom-client";

collectDefaultMetrics({ register });

export const httpRequestsTotal = new Counter({
  name: "archestra_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "status_code", "route"],
});

export const httpRequestDuration = new Histogram({
  name: "archestra_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "status_code", "route"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
});

export const dbConnectionsActive = new Gauge({
  name: "archestra_db_connections_active",
  help: "Number of active database connections",
});

export const dbConnectionsIdle = new Gauge({
  name: "archestra_db_connections_idle",
  help: "Number of idle database connections",
});

export const llmRequestsTotal = new Counter({
  name: "archestra_llm_requests_total",
  help: "Total number of LLM API requests",
  labelNames: ["provider", "model", "status"],
});

export const llmRequestDuration = new Histogram({
  name: "archestra_llm_request_duration_seconds",
  help: "LLM API request duration in seconds",
  labelNames: ["provider", "model"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

export const mcpRequestsTotal = new Counter({
  name: "archestra_mcp_requests_total",
  help: "Total number of MCP requests",
  labelNames: ["server", "method", "status"],
});

export const mcpRequestDuration = new Histogram({
  name: "archestra_mcp_request_duration_seconds",
  help: "MCP request duration in seconds",
  labelNames: ["server", "method"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

export const agentExecutionsTotal = new Counter({
  name: "archestra_agent_executions_total",
  help: "Total number of agent executions",
  labelNames: ["agent_id", "status"],
});

export const agentExecutionDuration = new Histogram({
  name: "archestra_agent_execution_duration_seconds",
  help: "Agent execution duration in seconds",
  labelNames: ["agent_id"],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120],
});

export const toolInvocationsTotal = new Counter({
  name: "archestra_tool_invocations_total",
  help: "Total number of tool invocations",
  labelNames: ["tool_name", "agent_id", "status"],
});

export const toolInvocationDuration = new Histogram({
  name: "archestra_tool_invocation_duration_seconds",
  help: "Tool invocation duration in seconds",
  labelNames: ["tool_name", "agent_id"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
});

export const activeUsers = new Gauge({
  name: "archestra_active_users",
  help: "Number of active users",
});

export const userSessionsTotal = new Counter({
  name: "archestra_user_sessions_total",
  help: "Total number of user sessions",
  labelNames: ["status"],
});

export const systemHealthStatus = new Gauge({
  name: "archestra_system_health_status",
  help: "System health status (1 = healthy, 0 = unhealthy)",
  labelNames: ["component"],
});

export async function getMetrics(): Promise<string> {
  return await register.metrics();
}

export function resetMetrics(): void {
  register.resetMetrics();
}
