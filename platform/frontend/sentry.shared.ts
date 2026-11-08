import {
  ERROR_REPORTING_DATA_COLLECTION,
  isAnalyticsEnabled,
  resolveErrorReporting,
  scrubErrorReportBreadcrumb,
  scrubErrorReportEvent,
} from "@archestra/shared/error-reporting";
import type { BrowserOptions, EdgeOptions, NodeOptions } from "@sentry/nextjs";

const FRONTEND_BROWSER_TRACES_SAMPLE_RATE = 0.05;
const FRONTEND_SERVER_TRACES_SAMPLE_RATE = 0.02;

/**
 * Archestra's Sentry project for frontend errors. A DSN only allows sending
 * events to the project, so it is public by design; it ships in the browser
 * bundle either way.
 */
const DEFAULT_FRONTEND_DSN =
  "https://5ff9bac572fb23e3620c066cbc93ce34@o4509825927479296.ingest.de.sentry.io/4510381678461008";

/**
 * Environments that mean "someone's laptop". A developer reporting from one
 * otherwise lands in the same project as the deployments, and those events
 * are indistinguishable from real ones at a glance while carrying local
 * absolute paths and a dev-server build's frames.
 */
const LOCAL_ENVIRONMENTS = new Set(["development", "test", "local"]);

export type FrontendErrorReporting = {
  enabled: boolean;
  dsn: string;
  environment: string | undefined;
  /** Archestra's default project: errors only, no traces or logs. */
  errorsOnly: boolean;
};

/**
 * Where frontend errors go. Every entry point (browser, server, edge) goes
 * through this so they cannot drift apart.
 *
 * Without NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN, errors go to Archestra's
 * project while analytics is on. An explicit DSN reports to that project,
 * independent of ARCHESTRA_ANALYTICS. Local environments never report; to
 * exercise reporting from a local build, set
 * NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT to something outside that set.
 */
export function resolveFrontendErrorReporting(params: {
  dsnOverride: string | undefined;
  environmentOverride: string | undefined;
  nodeEnv: string | undefined;
  analyticsEnabled: boolean;
}): FrontendErrorReporting {
  const resolved = resolveErrorReporting({
    ...params,
    defaultDsn: DEFAULT_FRONTEND_DSN,
  });
  return {
    ...resolved,
    enabled:
      resolved.enabled && !LOCAL_ENVIRONMENTS.has(resolved.environment ?? ""),
  };
}

/**
 * Error reporting for the Next.js server and edge runtimes, read from the
 * process environment at runtime. `process.env` is used directly because
 * next-runtime-env is not available there.
 */
export function getFrontendServerErrorReporting(): FrontendErrorReporting {
  return resolveFrontendErrorReporting({
    dsnOverride: process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN,
    environmentOverride: process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT,
    nodeEnv: process.env.NODE_ENV,
    analyticsEnabled: isAnalyticsEnabled({
      analytics: process.env.ARCHESTRA_ANALYTICS,
      nodeEnv: process.env.NODE_ENV,
    }),
  });
}

export function getFrontendBrowserSentryOptions(
  reporting: FrontendErrorReporting,
): BrowserOptions {
  return {
    ...getBaseOptions(reporting),
    ...(!reporting.errorsOnly && {
      tracesSampleRate: FRONTEND_BROWSER_TRACES_SAMPLE_RATE,
      enableLogs: true,
    }),
    // Session replay is PostHog's job; Sentry never records sessions.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  };
}

export function getFrontendServerSentryOptions(
  reporting: FrontendErrorReporting,
): NodeOptions {
  return {
    ...getBaseOptions(reporting),
    ...(!reporting.errorsOnly && {
      tracesSampleRate: FRONTEND_SERVER_TRACES_SAMPLE_RATE,
      enableLogs: true,
    }),
  };
}

export function getFrontendEdgeSentryOptions(
  reporting: FrontendErrorReporting,
): EdgeOptions {
  return {
    ...getBaseOptions(reporting),
    ...(!reporting.errorsOnly && {
      tracesSampleRate: FRONTEND_SERVER_TRACES_SAMPLE_RATE,
      enableLogs: true,
    }),
  };
}

// === Internal helpers ===

function getBaseOptions(reporting: FrontendErrorReporting) {
  return {
    dsn: reporting.dsn,
    environment: reporting.environment,
    dataCollection: ERROR_REPORTING_DATA_COLLECTION,
    // Errors only: no trace headers on outgoing requests.
    ...(reporting.errorsOnly && { tracePropagationTargets: [] }),
    beforeSend: scrubErrorReportEvent,
    beforeSendTransaction: scrubErrorReportEvent,
    beforeBreadcrumb: scrubErrorReportBreadcrumb,
  };
}
