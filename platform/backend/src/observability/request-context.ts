import { context, createContextKey } from "@opentelemetry/api";
import type { RouteCategory } from "./tracing/attributes";

/**
 * OTEL context key for the Archestra session ID (gen_ai.conversation.id).
 *
 * Set by `startActiveLlmSpan`, `startActiveMcpSpan`, and `startActiveChatSpan`
 * so that all code running within those spans (including log calls) can access
 * the session ID without prop-drilling.
 *
 * This enables direct Loki queries by session_id without going through traces.
 */
export const SESSION_ID_KEY = createContextKey("archestra.session_id");

/**
 * Returns the session ID from the active OTEL context, if set.
 * Used by the pino mixin in logging.ts to inject session_id into every log line.
 */
export function getActiveSessionId(): string | undefined {
  return context.active().getValue(SESSION_ID_KEY) as string | undefined;
}

/** The originating agent invocation category, preserved across child spans. */
export const CHAT_ROUTE_CATEGORY_KEY = createContextKey(
  "archestra.chat_route_category",
);

export function getActiveChatRouteCategory(): RouteCategory | undefined {
  return context.active().getValue(CHAT_ROUTE_CATEGORY_KEY) as
    | RouteCategory
    | undefined;
}
