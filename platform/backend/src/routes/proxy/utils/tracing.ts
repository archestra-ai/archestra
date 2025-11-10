import { type Span, trace } from "@opentelemetry/api";
import type { Agent } from "@/types";
import type { SupportedProvider } from "@/types/llm-providers";

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
 * @param agent - The agent object (optional, if provided will add agent.id, agent.name and agent labels)
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
      // Set agent attributes if agent is provided
      if (agent) {
        span.setAttribute("agent.id", agent.id);
        span.setAttribute("agent.name", agent.name);

        // Add all agent labels as attributes with agent.<key>=<value> format
        if (agent.labels && agent.labels.length > 0) {
          for (const label of agent.labels) {
            span.setAttribute(`agent.${label.key}`, label.value);
          }
        }
      }

      return await callback(span);
    },
  );
}
