import type { BrowserOptions, EdgeOptions, NodeOptions } from "@sentry/nextjs";

const FRONTEND_BROWSER_TRACES_SAMPLE_RATE = 0.05;
const FRONTEND_SERVER_TRACES_SAMPLE_RATE = 0.02;

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
