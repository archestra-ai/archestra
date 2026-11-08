import config from "@/config";

/**
 * Whether infrastructure spans (HTTP routes, outgoing HTTP calls, database
 * queries, DNS) are recorded. By default only agent spans are exported;
 * ARCHESTRA_OTEL_VERBOSE_TRACING adds the rest, and a Sentry project with
 * tracing (an explicitly configured DSN) receives the full trace for
 * debugging.
 */
export function infrastructureSpansEnabled(): boolean {
  const { sentry, otel } = config.observability;
  return (sentry.enabled && !sentry.errorsOnly) || otel.verboseTracing;
}
