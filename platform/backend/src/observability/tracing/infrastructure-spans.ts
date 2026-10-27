import config from "@/config";

/**
 * Whether infrastructure spans (HTTP routes, outgoing HTTP calls, database
 * queries, DNS) are recorded. By default only agent spans are exported;
 * ARCHESTRA_OTEL_VERBOSE_TRACING adds the rest, and Sentry always receives the
 * full trace for internal debugging.
 */
export function infrastructureSpansEnabled(): boolean {
  return (
    config.observability.sentry.enabled ||
    config.observability.otel.verboseTracing
  );
}
