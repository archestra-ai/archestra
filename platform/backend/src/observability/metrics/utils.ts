import {
  isSpanContextValid,
  context as otelContext,
  trace,
} from "@opentelemetry/api";
import { getActiveSessionId } from "@/observability/request-context";

const sanitizeRegexp = /[^a-zA-Z0-9_]/g;

/**
 * Sanitize a label key for Prometheus compatibility.
 * Prometheus label names must match [a-zA-Z_][a-zA-Z0-9_]*
 * - Replace invalid characters with underscores
 * - Prefix with underscore if starts with a digit
 */
export function sanitizeLabelKey(key: string): string {
  let sanitized = key.replace(sanitizeRegexp, "_");
  if (/^[0-9]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return sanitized;
}

/**
 * Get exemplar labels from the current OTEL trace context.
 * Returns traceId, spanId, and sessionID (if available) for linking
 * Prometheus metrics to specific traces and sessions in Grafana.
 */
export function getExemplarLabels(): Record<string, string> {
  const span = trace.getSpan(otelContext.active());
  if (!span) return {};

  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return {};

  const labels: Record<string, string> = {
    traceID: spanContext.traceId,
    spanID: spanContext.spanId,
  };

  const sessionId = getActiveSessionId();
  // OpenMetrics limits the combined label names and values to 128 characters.
  // Keep trace correlation, but omit an oversized session rather than truncate
  // it into an identifier that cannot resolve to the original session.
  const traceLabelLength = Object.entries(labels).reduce(
    (length, [key, value]) => length + key.length + value.length,
    0,
  );
  if (
    sessionId &&
    traceLabelLength + "sessionID".length + sessionId.length <= 128
  ) {
    labels.sessionID = sessionId;
  }

  return labels;
}
