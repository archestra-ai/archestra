import { trace } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";
import { classifyErrorForTracking } from "@/observability/error-tracking-policy";
import { posthogErrorTrackingService } from "@/services/error-tracking";

/**
 * Forward an unexpected server-side error (5xx) to PostHog Error Tracking,
 * scoped to the failing request's session/trace. Never throws — capture is
 * best-effort and must not disturb the error response.
 */
export function captureServerException(
  request: FastifyRequest,
  error: unknown,
  extraProperties?: Record<string, unknown>,
): void {
  // Use the shared policy so expected client/upstream errors are skipped and
  // availability incidents get a stable fingerprint.
  const decision = classifyErrorForTracking(error);
  if (!decision.report) {
    return;
  }

  const { distinctId, sessionId } = getPostHogTraceContext(request);
  posthogErrorTrackingService.captureException({
    error,
    distinctId,
    sessionId,
    traceId: trace.getActiveSpan()?.spanContext().traceId,
    properties: {
      method: request.method,
      url: request.url,
      route: request.routeOptions?.url,
      // The requested host (from the Host header) — identifies which
      // deployment hit the error, used by the PostHog Slack alert template.
      hostname: request.host,
      reqId: request.id,
      ...(decision.fingerprint && {
        $exception_fingerprint: decision.fingerprint.join("/"),
      }),
      ...decision.tags,
      ...extraProperties,
    },
  });
}

/**
 * Read the PostHog session/distinct id that posthog-js injects into browser
 * requests (via its `tracing_headers` config). These let a captured backend
 * exception be cross-referenced with the originating session replay and person.
 */
function getPostHogTraceContext(request: FastifyRequest): {
  distinctId?: string;
  sessionId?: string;
} {
  return {
    distinctId: firstHeaderValue(request.headers["x-posthog-distinct-id"]),
    sessionId: firstHeaderValue(request.headers["x-posthog-session-id"]),
  };
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
