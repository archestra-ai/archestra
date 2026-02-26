import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import config from "@/config";
import { SESSION_ID_KEY } from "@/observability/request-context";
import type { AgentType } from "@/types";
import {
  ATTR_ARCHESTRA_AGENT_TYPE,
  ATTR_GENAI_AGENT_ID,
  ATTR_GENAI_AGENT_NAME,
  ATTR_GENAI_OPERATION_NAME,
  ATTR_GENAI_TOOL_CALL_ARGUMENTS,
  ATTR_GENAI_TOOL_CALL_ID,
  ATTR_GENAI_TOOL_CALL_RESULT,
  ATTR_GENAI_TOOL_NAME,
  ATTR_GENAI_TOOL_TYPE,
  ATTR_MCP_BLOCKED,
  ATTR_MCP_BLOCKED_REASON,
  ATTR_MCP_SERVER_NAME,
  ATTR_ROUTE_CATEGORY,
  EVENT_GENAI_CONTENT_INPUT,
  EVENT_GENAI_CONTENT_OUTPUT,
  RouteCategory,
  type SpanAgentInfo,
  type SpanUserInfo,
  setAgentAttributes,
  setSessionId,
  setSpanError,
  setUserAttributes,
  truncateContent,
} from "./attributes";

const { captureContent } = config.observability.otel;

/**
 * Starts an active MCP span for tool call execution with attributes following
 * the OTEL GenAI Semantic Conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 *
 * Span name format: `execute_tool {toolName}`.
 *
 * @param params.toolName - The name of the tool being called
 * @param params.mcpServerName - The MCP server handling the tool call
 * @param params.agent - The agent/profile executing the tool call
 * @param params.sessionId - Conversation/session ID (optional)
 * @param params.agentType - The agent type (optional)
 * @param params.toolCallId - The unique ID for this tool call (optional)
 * @param params.toolArgs - The tool call arguments to capture as a span event (optional)
 * @param params.callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveMcpSpan<T>(params: {
  toolName: string;
  mcpServerName: string;
  agent: SpanAgentInfo;
  sessionId?: string | null;
  agentType?: AgentType;
  toolCallId?: string;
  toolArgs?: unknown;
  user?: SpanUserInfo | null;
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer("archestra");

  // Inject session ID into context so it's available to the pino mixin for log correlation
  let ctx = context.active();
  if (params.sessionId) {
    ctx = ctx.setValue(SESSION_ID_KEY, params.sessionId);
  }

  return tracer.startActiveSpan(
    `execute_tool ${params.toolName}`,
    {
      attributes: {
        [ATTR_ROUTE_CATEGORY]: RouteCategory.MCP_GATEWAY,
        [ATTR_GENAI_OPERATION_NAME]: "execute_tool",
        [ATTR_MCP_SERVER_NAME]: params.mcpServerName,
        [ATTR_GENAI_TOOL_NAME]: params.toolName,
        [ATTR_GENAI_TOOL_TYPE]: "function",
        [ATTR_GENAI_AGENT_ID]: params.agent.id,
        [ATTR_GENAI_AGENT_NAME]: params.agent.name,
      },
    },
    ctx,
    async (span) => {
      setAgentAttributes(span, params.agent);
      setSessionId(span, params.sessionId);

      if (params.agentType) {
        span.setAttribute(ATTR_ARCHESTRA_AGENT_TYPE, params.agentType);
      }
      if (params.toolCallId) {
        span.setAttribute(ATTR_GENAI_TOOL_CALL_ID, params.toolCallId);
      }

      setUserAttributes(span, params.user);

      if (captureContent && params.toolArgs) {
        span.addEvent(EVENT_GENAI_CONTENT_INPUT, {
          [ATTR_GENAI_TOOL_CALL_ARGUMENTS]: truncateContent(params.toolArgs),
        });
      }

      try {
        const result = await params.callback(span);
        span.setStatus({ code: SpanStatusCode.OK });

        if (captureContent) {
          span.addEvent(EVENT_GENAI_CONTENT_OUTPUT, {
            [ATTR_GENAI_TOOL_CALL_RESULT]: truncateContent(result),
          });
        }

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

/**
 * Records short-lived spans for tool calls that were blocked by tool invocation policies.
 * Each blocked tool call gets its own span with `mcp.blocked=true` and `mcp.blocked_reason`.
 *
 * These spans have the same attributes as normal MCP tool call spans so they appear alongside
 * executed tool calls in trace views and can be filtered by `mcp.blocked`.
 */
export function recordBlockedToolSpans(params: {
  toolCallNames: string[];
  blockedReason: string;
  agent: SpanAgentInfo;
  sessionId?: string | null;
  agentType?: AgentType;
  user?: SpanUserInfo | null;
}): void {
  const tracer = trace.getTracer("archestra");

  let ctx = context.active();
  if (params.sessionId) {
    ctx = ctx.setValue(SESSION_ID_KEY, params.sessionId);
  }

  for (const toolName of params.toolCallNames) {
    // Extract MCP server name from tool name convention: "servername__toolname"
    const separatorIndex = toolName.indexOf("__");
    const mcpServerName =
      separatorIndex > 0 ? toolName.substring(0, separatorIndex) : "unknown";

    const span = tracer.startSpan(
      `execute_tool ${toolName}`,
      {
        attributes: {
          [ATTR_ROUTE_CATEGORY]: RouteCategory.MCP_GATEWAY,
          [ATTR_GENAI_OPERATION_NAME]: "execute_tool",
          [ATTR_MCP_SERVER_NAME]: mcpServerName,
          [ATTR_GENAI_TOOL_NAME]: toolName,
          [ATTR_GENAI_TOOL_TYPE]: "function",
          [ATTR_GENAI_AGENT_ID]: params.agent.id,
          [ATTR_GENAI_AGENT_NAME]: params.agent.name,
          [ATTR_MCP_BLOCKED]: true,
          [ATTR_MCP_BLOCKED_REASON]: truncateContent(params.blockedReason),
        },
      },
      ctx,
    );

    setAgentAttributes(span, params.agent);
    setSessionId(span, params.sessionId);

    if (params.agentType) {
      span.setAttribute(ATTR_ARCHESTRA_AGENT_TYPE, params.agentType);
    }

    setUserAttributes(span, params.user);

    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: params.blockedReason,
    });
    span.end();
  }
}
