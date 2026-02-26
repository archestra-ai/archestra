import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import config from "@/config";

const { contentMaxLength } = config.observability.otel;

// ============================================================
// Route category
// ============================================================

/**
 * Route categories for tracing
 */
export enum RouteCategory {
  LLM_PROXY = "llm-proxy",
  MCP_GATEWAY = "mcp-gateway",
  CHAT = "chat",
  A2A = "a2a",
  CHATOPS = "chatops",
  EMAIL = "email",
}

// ============================================================
// Attribute constants (OTEL GenAI Semantic Conventions)
// ============================================================

// --- generic ---
export const ATTR_ROUTE_CATEGORY = "route.category";
export const ATTR_SERVER_ADDRESS = "server.address";
export const ATTR_ERROR_TYPE = "error.type";

// --- gen_ai request ---
export const ATTR_GENAI_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_GENAI_PROVIDER_NAME = "gen_ai.provider.name";
export const ATTR_GENAI_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_GENAI_REQUEST_STREAMING = "gen_ai.request.streaming";

// --- gen_ai agent ---
export const ATTR_GENAI_AGENT_ID = "gen_ai.agent.id";
export const ATTR_GENAI_AGENT_NAME = "gen_ai.agent.name";
export const ATTR_GENAI_CONVERSATION_ID = "gen_ai.conversation.id";

// --- gen_ai tool ---
export const ATTR_GENAI_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_GENAI_TOOL_TYPE = "gen_ai.tool.type";
export const ATTR_GENAI_TOOL_CALL_ID = "gen_ai.tool.call.id";

// --- gen_ai response ---
export const ATTR_GENAI_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_GENAI_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_GENAI_RESPONSE_FINISH_REASONS =
  "gen_ai.response.finish_reasons";
export const ATTR_GENAI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_GENAI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_GENAI_USAGE_TOTAL_TOKENS = "gen_ai.usage.total_tokens";

// --- gen_ai content events ---
export const EVENT_GENAI_CONTENT_PROMPT = "gen_ai.content.prompt";
export const EVENT_GENAI_CONTENT_INPUT = "gen_ai.content.input";
export const EVENT_GENAI_CONTENT_OUTPUT = "gen_ai.content.output";
export const EVENT_GENAI_CONTENT_COMPLETION = "gen_ai.content.completion";
export const ATTR_GENAI_PROMPT = "gen_ai.prompt";
export const ATTR_GENAI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const ATTR_GENAI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";
export const ATTR_GENAI_COMPLETION = "gen_ai.completion";

// --- archestra custom ---
export const ATTR_ARCHESTRA_AGENT_TYPE = "archestra.agent.type";
export const ATTR_ARCHESTRA_COST = "archestra.cost";
export const ATTR_ARCHESTRA_EXECUTION_ID = "archestra.execution.id";
export const ATTR_ARCHESTRA_EXTERNAL_AGENT_ID = "archestra.external_agent_id";
export const ATTR_ARCHESTRA_TRIGGER_SOURCE = "archestra.trigger.source";
export const ATTR_ARCHESTRA_USER_ID = "archestra.user.id";
export const ATTR_ARCHESTRA_USER_EMAIL = "archestra.user.email";
export const ATTR_ARCHESTRA_USER_NAME = "archestra.user.name";
export const ATTR_ARCHESTRA_LABEL_PREFIX = "archestra.label.";

// --- MCP custom ---
export const ATTR_MCP_SERVER_NAME = "mcp.server.name";
export const ATTR_MCP_BLOCKED = "mcp.blocked";
export const ATTR_MCP_BLOCKED_REASON = "mcp.blocked_reason";
export const ATTR_MCP_IS_ERROR_RESULT = "mcp.is_error_result";

// ============================================================
// Shared types
// ============================================================

export interface SpanAgentInfo {
  id: string;
  name: string;
  agentType?: string;
  labels?: { key: string; value: string }[];
}

export interface SpanUserInfo {
  id: string;
  email?: string;
  name?: string;
}

// ============================================================
// Helpers
// ============================================================

export function setAgentAttributes(span: Span, agent: SpanAgentInfo): void {
  span.setAttribute(ATTR_GENAI_AGENT_ID, agent.id);
  span.setAttribute(ATTR_GENAI_AGENT_NAME, agent.name);

  if (agent.agentType) {
    span.setAttribute(ATTR_ARCHESTRA_AGENT_TYPE, agent.agentType);
  }

  if (agent.labels && agent.labels.length > 0) {
    for (const label of agent.labels) {
      span.setAttribute(
        `${ATTR_ARCHESTRA_LABEL_PREFIX}${label.key}`,
        label.value,
      );
    }
  }
}

export function setUserAttributes(
  span: Span,
  user: SpanUserInfo | null | undefined,
): void {
  if (!user) return;
  span.setAttribute(ATTR_ARCHESTRA_USER_ID, user.id);
  if (user.email) span.setAttribute(ATTR_ARCHESTRA_USER_EMAIL, user.email);
  if (user.name) span.setAttribute(ATTR_ARCHESTRA_USER_NAME, user.name);
}

export function setSessionId(
  span: Span,
  sessionId: string | null | undefined,
): void {
  if (sessionId) {
    span.setAttribute(ATTR_GENAI_CONVERSATION_ID, sessionId);
  }
}

export function setSpanError(span: Span, error: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : "Unknown error",
  });
  span.setAttribute(
    ATTR_ERROR_TYPE,
    error instanceof Error ? error.constructor.name : "Error",
  );
}

export function truncateContent(content: unknown): string {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  if (str.length <= contentMaxLength) {
    return str;
  }
  return `${str.slice(0, contentMaxLength)}...[truncated]`;
}
