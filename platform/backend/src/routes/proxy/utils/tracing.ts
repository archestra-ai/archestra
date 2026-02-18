import {
  type Context,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { SupportedProvider } from "@shared";
import config from "@/config";
import logger from "@/logging";
import { SESSION_ID_KEY } from "@/observability/request-context";
import type { Agent, AgentType, GenAiOperationName } from "@/types";

const { captureContent, contentMaxLength } = config.observability.otel;

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

/**
 * Starts an active LLM span with attributes following the OTEL GenAI Semantic Conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 *
 * Span name format: `{operationName} {model}` (e.g., "chat gpt-4o-mini").
 * The operationName is provided by each LLM adapter's `getSpanName()` method,
 * which returns a `GenAiOperationName` value.
 *
 * Lifecycle: The span is automatically ended in a finally block. The callback
 * should NOT call `span.end()`. On success, span status is set to OK. On error,
 * span status is set to ERROR with `error.type` attribute.
 *
 * @param params.operationName - The GenAI operation name (e.g., "chat", "generate_content")
 * @param params.provider - The LLM provider (openai, gemini, anthropic, etc.)
 * @param params.model - The LLM model being used
 * @param params.stream - Whether this is a streaming request
 * @param params.agent - The agent/profile object (optional)
 * @param params.sessionId - Conversation/session ID (optional)
 * @param params.executionId - Execution ID for tracking agent executions (optional)
 * @param params.externalAgentId - External agent ID from X-Archestra-Agent-Id header (optional)
 * @param params.serverAddress - The server address (base URL) of the LLM provider (optional)
 * @param params.promptMessages - The prompt messages to capture as a span event (optional)
 * @param params.callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveLlmSpan<T>(params: {
  operationName: GenAiOperationName;
  provider: SupportedProvider;
  model: string;
  stream: boolean;
  agent?: Agent;
  sessionId?: string | null;
  executionId?: string;
  externalAgentId?: string;
  serverAddress?: string;
  promptMessages?: unknown;
  parentContext?: Context;
  user?: { id: string; email?: string; name?: string } | null;
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const spanName = `${params.operationName} ${params.model}`;
  logger.debug(
    {
      spanName,
      provider: params.provider,
      model: params.model,
      stream: params.stream,
      agentId: params.agent?.id,
    },
    "[tracing] startActiveLlmSpan: creating span",
  );
  const tracer = trace.getTracer("archestra");

  const spanOptions = {
    kind: SpanKind.CLIENT,
    attributes: {
      "route.category": RouteCategory.LLM_PROXY,
      "gen_ai.operation.name": params.operationName,
      "gen_ai.provider.name": params.provider,
      "gen_ai.request.model": params.model,
      "gen_ai.request.streaming": params.stream,
    },
  };

  const spanCallback = async (span: Span) => {
    if (params.agent) {
      logger.debug(
        {
          agentId: params.agent.id,
          agentName: params.agent.name,
          labelCount: params.agent.labels?.length || 0,
        },
        "[tracing] startActiveLlmSpan: setting agent attributes",
      );
      span.setAttribute("gen_ai.agent.id", params.agent.id);
      span.setAttribute("gen_ai.agent.name", params.agent.name);

      if (params.agent.agentType) {
        span.setAttribute("archestra.agent.type", params.agent.agentType);
      }

      if (params.agent.labels && params.agent.labels.length > 0) {
        for (const label of params.agent.labels) {
          span.setAttribute(`archestra.label.${label.key}`, label.value);
        }
      }
    }

    if (params.sessionId) {
      span.setAttribute("gen_ai.conversation.id", params.sessionId);
    }
    if (params.executionId) {
      span.setAttribute("archestra.execution.id", params.executionId);
    }
    if (params.externalAgentId) {
      span.setAttribute("archestra.external_agent_id", params.externalAgentId);
    }
    if (params.serverAddress) {
      span.setAttribute("server.address", params.serverAddress);
    }

    if (params.user) {
      span.setAttribute("archestra.user.id", params.user.id);
      if (params.user.email)
        span.setAttribute("archestra.user.email", params.user.email);
      if (params.user.name)
        span.setAttribute("archestra.user.name", params.user.name);
    }

    if (captureContent && params.promptMessages) {
      span.addEvent("gen_ai.content.prompt", {
        "gen_ai.prompt": truncateContent(params.promptMessages),
      });
    }

    logger.debug(
      { spanName },
      "[tracing] startActiveLlmSpan: executing callback",
    );

    try {
      const result = await params.callback(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      span.setAttribute(
        "error.type",
        error instanceof Error ? error.constructor.name : "Error",
      );
      throw error;
    } finally {
      span.end();
    }
  };

  // Build the context: start from parentContext (if provided) or current context,
  // then inject the session ID so it's available to the pino mixin for log correlation.
  let ctx = params.parentContext ?? context.active();
  if (params.sessionId) {
    ctx = ctx.setValue(SESSION_ID_KEY, params.sessionId);
  }

  return tracer.startActiveSpan(spanName, spanOptions, ctx, spanCallback);
}

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
  agent: { id: string; name: string; labels?: Agent["labels"] };
  sessionId?: string | null;
  agentType?: AgentType;
  toolCallId?: string;
  toolArgs?: unknown;
  user?: { id: string; email?: string; name?: string } | null;
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
        "route.category": RouteCategory.MCP_GATEWAY,
        "gen_ai.operation.name": "execute_tool",
        "mcp.server.name": params.mcpServerName,
        "gen_ai.tool.name": params.toolName,
        "gen_ai.tool.type": "function",
        "gen_ai.agent.id": params.agent.id,
        "gen_ai.agent.name": params.agent.name,
      },
    },
    ctx,
    async (span) => {
      if (params.agent.labels && params.agent.labels.length > 0) {
        for (const label of params.agent.labels) {
          span.setAttribute(`archestra.label.${label.key}`, label.value);
        }
      }

      if (params.sessionId) {
        span.setAttribute("gen_ai.conversation.id", params.sessionId);
      }
      if (params.agentType) {
        span.setAttribute("archestra.agent.type", params.agentType);
      }
      if (params.toolCallId) {
        span.setAttribute("gen_ai.tool.call.id", params.toolCallId);
      }

      if (params.user) {
        span.setAttribute("archestra.user.id", params.user.id);
        if (params.user.email)
          span.setAttribute("archestra.user.email", params.user.email);
        if (params.user.name)
          span.setAttribute("archestra.user.name", params.user.name);
      }

      if (captureContent && params.toolArgs) {
        span.addEvent("gen_ai.content.input", {
          "gen_ai.tool.call.arguments": truncateContent(params.toolArgs),
        });
      }

      try {
        const result = await params.callback(span);
        span.setStatus({ code: SpanStatusCode.OK });

        if (captureContent) {
          span.addEvent("gen_ai.content.output", {
            "gen_ai.tool.call.result": truncateContent(result),
          });
        }

        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.setAttribute(
          "error.type",
          error instanceof Error ? error.constructor.name : "Error",
        );
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

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
  labels?: Agent["labels"];
  routeCategory?: RouteCategory;
  triggerSource?: string;
  user?: { id: string; email?: string; name?: string } | null;
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
        "route.category": routeCategory,
        "gen_ai.operation.name": "chat",
        "gen_ai.agent.id": params.agentId,
        "gen_ai.agent.name": params.agentName,
      },
    },
    ctx,
    async (span) => {
      if (params.sessionId) {
        span.setAttribute("gen_ai.conversation.id", params.sessionId);
      }
      if (params.agentType) {
        span.setAttribute("archestra.agent.type", params.agentType);
      }
      if (params.triggerSource) {
        span.setAttribute("archestra.trigger.source", params.triggerSource);
      }
      if (params.user) {
        span.setAttribute("archestra.user.id", params.user.id);
        if (params.user.email)
          span.setAttribute("archestra.user.email", params.user.email);
        if (params.user.name)
          span.setAttribute("archestra.user.name", params.user.name);
      }
      if (params.labels && params.labels.length > 0) {
        for (const label of params.labels) {
          span.setAttribute(`archestra.label.${label.key}`, label.value);
        }
      }

      try {
        const result = await params.callback(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.setAttribute(
          "error.type",
          error instanceof Error ? error.constructor.name : "Error",
        );
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// ============================================================
// Internal helpers
// ============================================================

function truncateContent(content: unknown): string {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  if (str.length <= contentMaxLength) {
    return str;
  }
  return `${str.slice(0, contentMaxLength)}...[truncated]`;
}
