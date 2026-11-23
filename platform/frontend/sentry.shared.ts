import { DEFAULT_INTERNAL_API_BASE_URL } from "@archestra/shared/consts";
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
 * project while analytics is on (off by default with an enterprise license).
 * An explicit DSN reports to that project,
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
      enterpriseLicenseActivated:
        process.env.ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED === "true",
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
    ...getTelemetryChoiceFilters(reporting),
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
    ...getTelemetryChoiceFilters(reporting),
    ...(!reporting.errorsOnly && {
      tracesSampleRate: FRONTEND_SERVER_TRACES_SAMPLE_RATE,
      enableLogs: true,
    }),
  };
}

/**
 * Whether the instance still allows telemetry: the deployment setting and
 * the choice an admin made in the first-run setup dialog, as the backend's
 * public config reports them. The Next.js server and edge runtimes cannot
 * read the database, so they ask the backend, at most once a minute. When
 * the backend cannot be reached, nothing is sent.
 */
async function isInstanceTelemetryEnabled(): Promise<boolean> {
  if (telemetryChoice && telemetryChoice.expiresAt > Date.now()) {
    return telemetryChoice.enabled;
  }
  let enabled = false;
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL ||
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL ||
      DEFAULT_INTERNAL_API_BASE_URL;
    const response = await fetch(new URL(PUBLIC_CONFIG_PATH, baseUrl), {
      signal: AbortSignal.timeout(TELEMETRY_CHOICE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json()) as {
        analytics?: { enabled?: boolean };
      };
      enabled = body.analytics?.enabled === true;
    }
  } catch {
    enabled = false;
  }
  telemetryChoice = {
    enabled,
    expiresAt: Date.now() + TELEMETRY_CHOICE_TTL_MS,
  };
  return enabled;
}

// === Internal helpers ===

const PUBLIC_CONFIG_PATH = "/api/config/public";
const TELEMETRY_CHOICE_TTL_MS = 60_000;
const TELEMETRY_CHOICE_TIMEOUT_MS = 3_000;
let telemetryChoice: { enabled: boolean; expiresAt: number } | null = null;

/**
 * Server and edge reports to Archestra's project also follow the admin's
 * telemetry choice. The deployment's own project always gets its reports.
 */
function getTelemetryChoiceFilters(reporting: FrontendErrorReporting) {
  if (!reporting.errorsOnly) return {};
  return {
    beforeSend: async <T extends object>(event: T) =>
      (await isInstanceTelemetryEnabled())
        ? scrubErrorReportEvent(event)
        : null,
  };
}

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
