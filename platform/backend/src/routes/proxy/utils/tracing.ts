import { context, trace } from "@opentelemetry/api";
import logger from "@/logging";
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
 * Sprinkles trace attributes on the current active span.
 * This centralizes the logic for adding consistent attributes across all LLM proxy routes.
 *
 * @param provider - The LLM provider (openai, gemini, or anthropic)
 * @param category - The route category (defaults to llm-proxy)
 * @param agent - The agent object (optional, if provided will add agent.id, agent.name and agent labels)
 */
export function sprinkleTraceAttributes(
  provider: SupportedProvider,
  category: RouteCategory = RouteCategory.LLM_PROXY,
  agent?: Agent,
): void {
  // Get the active span from the current context
  const span = trace.getSpan(context.active());

  if (!span) {
    logger.warn("[tracing] No active span found when trying to set attributes");
    return;
  }

  // Set basic route attributes
  span.setAttribute("route.category", category);
  span.setAttribute("llm.provider", provider);

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
}
