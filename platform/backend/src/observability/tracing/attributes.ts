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
// Prompt-cache token counts, per the GenAI semconv. Read = served from a
// provider cache, creation = written to it. Both are a subset of
// gen_ai.usage.input_tokens (the span attribute adds cache read/write back onto
// our internally-uncached input count, so the spec's subset relationship holds).
export const ATTR_GENAI_USAGE_CACHE_READ_INPUT_TOKENS =
  "gen_ai.usage.cache_read.input_tokens";
export const ATTR_GENAI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";
// Portion of cache-creation tokens written at the 1-hour TTL (Anthropic/Bedrock),
// billed at a higher surcharge than the 5-minute default. The GenAI semconv has no
// per-TTL breakdown of cache_creation tokens, so this uses the archestra.* namespace.
// The rest of gen_ai.usage.cache_creation.input_tokens is the 5m-TTL remainder.
export const ATTR_ARCHESTRA_USAGE_CACHE_CREATION_1H_INPUT_TOKENS =
  "archestra.usage.cache_creation.1h_input_tokens";
// Output tokens spent on reasoning / extended thinking. Per the GenAI semconv this
// value is a subset of gen_ai.usage.output_tokens. Reported by OpenAI
// (reasoning_tokens) and Gemini (thoughtsTokenCount); unset for providers that
// do not break reasoning tokens out separately.
export const ATTR_GENAI_USAGE_REASONING_OUTPUT_TOKENS =
  "gen_ai.usage.reasoning.output_tokens";

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
export const ATTR_ARCHESTRA_AUTH_METHOD = "archestra.auth.method";
export const ATTR_ARCHESTRA_APP_ID = "archestra.app.id";
export const ATTR_ARCHESTRA_APP_NAME = "archestra.app.name";
export const ATTR_ARCHESTRA_USER_ID = "archestra.user.id";
export const ATTR_ARCHESTRA_USER_EMAIL = "archestra.user.email";
export const ATTR_ARCHESTRA_USER_NAME = "archestra.user.name";
export const ATTR_ARCHESTRA_AGENT_LABEL_PREFIX = "archestra.agent.label.";
// Team metadata. Teams are an Archestra concept with no OTEL semantic-convention
// registry equivalent, so the custom `archestra.<scope>.team.*` namespace is
// used, where scope is the principal the teams belong to (`agent` or `user`). A
// principal can belong to multiple teams, so ids/names are array-valued and team
// label values are merged per key across all of the principal's teams.

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

export interface SpanTeamInfo {
  id: string;
  name: string;
  labels?: { key: string; value: string }[];
}

/** The principal a set of teams belongs to, used to namespace team span attributes. */
type TeamScope = "agent" | "user";

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
        `${ATTR_ARCHESTRA_AGENT_LABEL_PREFIX}${label.key}`,
        label.value,
      );
    }
  }
}

/**
 * Set team span attributes for a principal under `archestra.<scope>.team.*`:
 * `.ids` and `.names` (array-valued, since a principal can belong to multiple
 * teams) and `.label.<key>` (label values merged per key across the principal's
 * teams). `scope` distinguishes the agent's teams from the requesting user's.
 */
export function setTeamAttributes(
  span: Span,
  teams: SpanTeamInfo[] | null | undefined,
  scope: TeamScope,
): void {
  if (!teams || teams.length === 0) return;

  const base = `archestra.${scope}.team`;
  span.setAttribute(
    `${base}.ids`,
    teams.map((team) => team.id),
  );
  span.setAttribute(
    `${base}.names`,
    teams.map((team) => team.name),
  );

  // Merge label values per key across the principal's teams. A key can carry
  // different values on different teams, so each attribute is array-valued.
  const valuesByKey = new Map<string, Set<string>>();
  for (const team of teams) {
    for (const label of team.labels ?? []) {
      const values = valuesByKey.get(label.key) ?? new Set<string>();
      values.add(label.value);
      valuesByKey.set(label.key, values);
    }
  }
  for (const [key, values] of valuesByKey) {
    span.setAttribute(`${base}.label.${key}`, [...values]);
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
