import { context, createContextKey } from "@opentelemetry/api";

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
