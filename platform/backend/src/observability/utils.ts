import {
  HEALTH_PATH,
  METRICS_PATH,
  READY_PATH,
  WELL_KNOWN_OAUTH_PREFIX,
} from "@/routes/route-paths";

/**
 * Routes that should be excluded from tracing entirely.
 * Used by both Sentry tracesSampler and OTEL FastifyOtelInstrumentation ignorePaths.
 */
export function isNoiseRoute(url: string): boolean {
  return (
    url.startsWith(HEALTH_PATH) ||
    url.startsWith(READY_PATH) ||
    url.startsWith(METRICS_PATH) ||
    url.startsWith(WELL_KNOWN_OAUTH_PREFIX)
  );
}
