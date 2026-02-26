import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { SESSION_ID_KEY } from "@/observability/request-context";
import type { AgentType } from "@/types";
import {
  ATTR_ARCHESTRA_AGENT_TYPE,
  ATTR_ARCHESTRA_LABEL_PREFIX,
  ATTR_ARCHESTRA_TRIGGER_SOURCE,
  ATTR_GENAI_AGENT_ID,
  ATTR_GENAI_AGENT_NAME,
  ATTR_GENAI_OPERATION_NAME,
  ATTR_ROUTE_CATEGORY,
  RouteCategory,
  type SpanUserInfo,
  setSessionId,
  setSpanError,
  setUserAttributes,
} from "./attributes";

/**
 * Starts an active parent chat span that groups LLM and MCP tool calls within
 * a single chat turn into a unified trace.
 *
 * Span name format: `chat {agentName}`.
 *
 * @param params.agentName - The agent/profile name
 * @param params.agentId - The agent/profile ID
 * @param params.agentType - The agent type (optional)
 * @param params.sessionId - Conversation/session ID (optional)
 * @param params.labels - Agent labels (optional)
 * @param params.routeCategory - The route category (defaults to RouteCategory.CHAT)
 * @param params.triggerSource - The invocation trigger (e.g. "ms-teams", "slack", "email", "mcp-tool")
 * @param params.callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveChatSpan<T>(params: {
  agentName: string;
  agentId: string;
  agentType?: AgentType;
  sessionId?: string;
  labels?: { key: string; value: string }[];
  routeCategory?: RouteCategory;
  triggerSource?: string;
  user?: SpanUserInfo | null;
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer("archestra");
  const routeCategory = params.routeCategory ?? RouteCategory.CHAT;
  const spanName = `chat ${params.agentName}`;

  // Inject session ID into context so it's available to the pino mixin for log correlation
  let ctx = context.active();
  if (params.sessionId) {
    ctx = ctx.setValue(SESSION_ID_KEY, params.sessionId);
  }

  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_ROUTE_CATEGORY]: routeCategory,
        [ATTR_GENAI_OPERATION_NAME]: "chat",
        [ATTR_GENAI_AGENT_ID]: params.agentId,
        [ATTR_GENAI_AGENT_NAME]: params.agentName,
      },
    },
    ctx,
    async (span) => {
      setSessionId(span, params.sessionId);

      if (params.agentType) {
        span.setAttribute(ATTR_ARCHESTRA_AGENT_TYPE, params.agentType);
      }
      if (params.triggerSource) {
        span.setAttribute(ATTR_ARCHESTRA_TRIGGER_SOURCE, params.triggerSource);
      }

      setUserAttributes(span, params.user);

      if (params.labels && params.labels.length > 0) {
        for (const label of params.labels) {
          span.setAttribute(
            `${ATTR_ARCHESTRA_LABEL_PREFIX}${label.key}`,
            label.value,
          );
        }
      }

      try {
        const result = await params.callback(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        setSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
