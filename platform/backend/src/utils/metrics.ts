import {
  agentExecutionDuration,
  agentExecutionsTotal,
  llmRequestDuration,
  llmRequestsTotal,
  mcpRequestDuration,
  mcpRequestsTotal,
  toolInvocationDuration,
  toolInvocationsTotal,
  userSessionsTotal,
} from "../metrics";

export function trackLLMRequest(
  provider: string,
  model: string,
  status: "success" | "error",
) {
  llmRequestsTotal.inc({ provider, model, status });
}

export function trackLLMRequestDuration(
  provider: string,
  model: string,
  durationSeconds: number,
) {
  llmRequestDuration.observe({ provider, model }, durationSeconds);
}

export function trackAgentExecution(
  agentId: string,
  status: "success" | "error",
) {
  agentExecutionsTotal.inc({ agent_id: agentId, status });
}

export function trackAgentExecutionDuration(
  agentId: string,
  durationSeconds: number,
) {
  agentExecutionDuration.observe({ agent_id: agentId }, durationSeconds);
}

export function trackToolInvocation(
  toolName: string,
  agentId: string,
  status: "success" | "error",
) {
  toolInvocationsTotal.inc({ tool_name: toolName, agent_id: agentId, status });
}

export function trackToolInvocationDuration(
  toolName: string,
  agentId: string,
  durationSeconds: number,
) {
  toolInvocationDuration.observe(
    { tool_name: toolName, agent_id: agentId },
    durationSeconds,
  );
}

export function trackMCPRequest(
  server: string,
  method: string,
  status: "success" | "error",
) {
  mcpRequestsTotal.inc({ server, method, status });
}

export function trackMCPRequestDuration(
  server: string,
  method: string,
  durationSeconds: number,
) {
  mcpRequestDuration.observe({ server, method }, durationSeconds);
}

export function trackUserSession(status: "login" | "logout") {
  userSessionsTotal.inc({ status });
}
