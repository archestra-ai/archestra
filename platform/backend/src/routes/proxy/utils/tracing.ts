import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { SupportedProvider } from "@shared";
import logger from "@/logging";
import type { Agent } from "@/types";

/**
 * Route categories for tracing
 */
export enum RouteCategory {
  LLM_PROXY = "llm-proxy",
  MCP_GATEWAY = "mcp-gateway",
  API = "api",
}

/**
 * Starts an active LLM span with consistent attributes across all LLM proxy routes.
 * This is a wrapper around tracer.startActiveSpan that encapsulates tracer creation
 * and adds standardized LLM-specific attributes.
 *
 * @param spanName - The name of the span (e.g., "openai.chat.completions")
 * @param provider - The LLM provider (openai, gemini, or anthropic)
 * @param llmModel - The LLM model being used
 * @param stream - Whether this is a streaming request
 * @param agent - The agent/profile object (optional, if provided will add both agent.* and profile.* attributes)
 *                Note: agent.* attributes are deprecated in favor of profile.* attributes
 * @param callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveLlmSpan<T>(
  spanName: string,
  provider: SupportedProvider,
  llmModel: string,
  stream: boolean,
  agent: Agent | undefined,
  callback: (span: Span) => Promise<T>,
): Promise<T> {
  logger.debug(
    { spanName, provider, llmModel, stream, agentId: agent?.id },
    "[tracing] startActiveLlmSpan: creating span",
  );
  const tracer = trace.getTracer("archestra");

  return tracer.startActiveSpan(
    spanName,
    {
      attributes: {
        "route.category": RouteCategory.LLM_PROXY,
        "llm.provider": provider,
        "llm.model": llmModel,
        "llm.stream": stream,
      },
    },
    async (span) => {
      // Set agent/profile attributes if agent is provided
      // NOTE: profile.* attributes are the preferred attributes going forward.
      // agent.* attributes are deprecated and will be removed in a future release.
      // Both are emitted during the transition period to allow dashboards/traces to migrate.
      if (agent) {
        logger.debug(
          {
            agentId: agent.id,
            agentName: agent.name,
            labelCount: agent.labels?.length || 0,
          },
          "[tracing] startActiveLlmSpan: setting agent attributes",
        );
        span.setAttribute("agent.id", agent.id);
        span.setAttribute("agent.name", agent.name);
        span.setAttribute("profile.id", agent.id);
        span.setAttribute("profile.name", agent.name);

        // Add all labels as attributes with both agent.<key>=<value> and profile.<key>=<value> format
        if (agent.labels && agent.labels.length > 0) {
          for (const label of agent.labels) {
            span.setAttribute(`agent.${label.key}`, label.value);
            span.setAttribute(`profile.${label.key}`, label.value);
          }
        }
      }

      logger.debug(
        { spanName },
        "[tracing] startActiveLlmSpan: executing callback",
      );
      return await callback(span);
    },
  );
}

/**
 * Starts an active MCP span for tool call execution.
 * Creates an OpenTelemetry span with MCP-specific attributes for tracing tool calls
 * through the MCP Gateway.
 *
 * @param toolName - The name of the tool being called
 * @param mcpServerName - The MCP server handling the tool call
 * @param agent - The agent/profile executing the tool call
 * @param callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveMcpSpan<T>(params: {
  toolName: string;
  mcpServerName: string;
  agent: { id: string; name: string; labels?: Agent["labels"] };
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer("archestra");

  return tracer.startActiveSpan(
    `mcp.${params.mcpServerName}.${params.toolName}`,
    {
      attributes: {
        "route.category": RouteCategory.MCP_GATEWAY,
        "mcp.server_name": params.mcpServerName,
        "mcp.tool_name": params.toolName,
        "profile.id": params.agent.id,
        "profile.name": params.agent.name,
      },
    },
    async (span) => {
      if (params.agent.labels && params.agent.labels.length > 0) {
        for (const label of params.agent.labels) {
          span.setAttribute(`profile.${label.key}`, label.value);
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
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
