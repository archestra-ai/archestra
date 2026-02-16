import {
  isSpanContextValid,
  context as otelContext,
  trace,
} from "@opentelemetry/api";

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
 * Returns traceId and spanId if a valid span context is active,
 * or an empty object otherwise.
 *
 * Used to link Prometheus metrics to specific traces in Grafana
 * via exemplar-based metric-to-trace navigation.
 */
export function getExemplarLabels(): Record<string, string> {
  const span = trace.getSpan(otelContext.active());
  if (!span) return {};

  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return {};

  return {
    traceID: spanContext.traceId,
    spanID: spanContext.spanId,
  };
}
