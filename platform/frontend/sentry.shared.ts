import type { BrowserOptions, EdgeOptions, NodeOptions } from "@sentry/nextjs";

const FRONTEND_BROWSER_TRACES_SAMPLE_RATE = 0.05;
const FRONTEND_SERVER_TRACES_SAMPLE_RATE = 0.02;

/**
 * Environments that mean "someone's laptop". A developer who has the DSN in
 * their local env file otherwise reports into the same project as the
 * deployments, and those events are indistinguishable from real ones at a
 * glance while carrying local absolute paths and a dev-server build's frames.
 */
const LOCAL_ENVIRONMENTS = new Set(["development", "test", "local"]);

/**
 * Whether frontend telemetry should start at all. Every entry point (browser,
 * server, edge) goes through this so they cannot drift apart.
 *
 * To exercise reporting from a local build, set the environment override
 * (NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT) to something outside this set.
 */
export function shouldEnableFrontendTelemetry(params: {
  dsn: string | undefined;
  environment: string | undefined;
}): boolean {
  if (!params.dsn) return false;
  return !LOCAL_ENVIRONMENTS.has(params.environment?.toLowerCase() ?? "");
}

export function getFrontendBrowserSentryOptions(
  params: Pick<BrowserOptions, "dsn" | "environment">,
): BrowserOptions {
  return {
    dsn: params.dsn,
    environment: params.environment,
    tracesSampleRate: FRONTEND_BROWSER_TRACES_SAMPLE_RATE,
    enableLogs: true,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: true,
  };
}

export function getFrontendServerSentryOptions(
  params: Pick<NodeOptions, "dsn" | "environment">,
): NodeOptions {
  return {
    dsn: params.dsn,
    environment: params.environment,
    tracesSampleRate: FRONTEND_SERVER_TRACES_SAMPLE_RATE,
    enableLogs: true,
    sendDefaultPii: true,
  };
}

export function getFrontendEdgeSentryOptions(
  params: Pick<EdgeOptions, "dsn" | "environment">,
): EdgeOptions {
  return {
    dsn: params.dsn,
    environment: params.environment,
    tracesSampleRate: FRONTEND_SERVER_TRACES_SAMPLE_RATE,
    enableLogs: true,
    sendDefaultPii: true,
  };
}
