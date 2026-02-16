import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { SupportedProvider } from "@shared";
import logger from "@/logging";
import type { Agent, AgentType, GenAiOperationName } from "@/types";

/**
 * Route categories for tracing
 */
export enum RouteCategory {
  LLM_PROXY = "llm-proxy",
  MCP_GATEWAY = "mcp-gateway",
  API = "api",
}

/**
 * Starts an active LLM span with attributes following the OTEL GenAI Semantic Conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 *
 * Span name format: `{operationName} {model}` (e.g., "chat gpt-4o-mini").
 * The operationName is provided by each LLM adapter's `getSpanName()` method,
 * which returns a `GenAiOperationName` value.
 *
 * @param params.operationName - The GenAI operation name (e.g., "chat", "generate_content")
 * @param params.provider - The LLM provider (openai, gemini, anthropic, etc.)
 * @param params.model - The LLM model being used
 * @param params.stream - Whether this is a streaming request
 * @param params.agent - The agent/profile object (optional)
 * @param params.sessionId - Conversation/session ID (optional)
 * @param params.executionId - Execution ID for tracking agent executions (optional)
 * @param params.externalAgentId - External agent ID from X-Archestra-Agent-Id header (optional)
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

  return tracer.startActiveSpan(
    spanName,
    {
      attributes: {
        "route.category": RouteCategory.LLM_PROXY,
        "gen_ai.operation.name": params.operationName,
        "gen_ai.provider.name": params.provider,
        "gen_ai.request.model": params.model,
        "gen_ai.request.streaming": params.stream,
      },
    },
    async (span) => {
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
        span.setAttribute(
          "archestra.external_agent_id",
          params.externalAgentId,
        );
      }

      logger.debug(
        { spanName },
        "[tracing] startActiveLlmSpan: executing callback",
      );
      return await params.callback(span);
    },
  );
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
 * @param params.callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveMcpSpan<T>(params: {
  toolName: string;
  mcpServerName: string;
  agent: { id: string; name: string; labels?: Agent["labels"] };
  sessionId?: string | null;
  agentType?: AgentType;
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer("archestra");

  return tracer.startActiveSpan(
    `execute_tool ${params.toolName}`,
    {
      attributes: {
        "route.category": RouteCategory.MCP_GATEWAY,
        "gen_ai.operation.name": "execute_tool",
        "mcp.server.name": params.mcpServerName,
        "gen_ai.tool.name": params.toolName,
        "gen_ai.agent.id": params.agent.id,
        "gen_ai.agent.name": params.agent.name,
      },
    },
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

      try {
        const result = await params.callback(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
