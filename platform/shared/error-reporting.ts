/**
 * Error reporting rules shared by the backend and the frontend.
 *
 * Every deployment reports errors to Archestra's Sentry project unless
 * `ARCHESTRA_ANALYTICS=disabled`, so a report leaves customer infrastructure
 * by default. These rules decide when reporting starts and strip what a
 * report must never carry: request content, credentials, personal data, and
 * conversation content.
 */

/**
 * Whether `ARCHESTRA_ANALYTICS` turns analytics and default error reporting
 * on. Unset means on only in production builds, so local development and test
 * runs stay silent. "disabled" turns it off; any other value turns it on.
 */
export function isAnalyticsEnabled(params: {
  analytics: string | undefined;
  nodeEnv: string | undefined;
}): boolean {
  const value = params.analytics?.trim();
  if (value) return value !== "disabled";
  return ["production", "prod"].includes(
    params.nodeEnv?.trim().toLowerCase() ?? "",
  );
}

/**
 * Where errors go and how much is sent.
 *
 * - An explicit DSN is the deployment's own Sentry project. It reports with
 *   the full diagnostics the deployment configured (traces, logs, profiles),
 *   whatever `ARCHESTRA_ANALYTICS` says, because the data stays with its
 *   owner.
 * - Without one, errors go to Archestra's project when analytics is on, and
 *   only errors: no traces, logs, or profiles leave the deployment.
 */
export function resolveErrorReporting(params: {
  dsnOverride: string | undefined;
  defaultDsn: string;
  environmentOverride: string | undefined;
  nodeEnv: string | undefined;
  analyticsEnabled: boolean;
}): {
  enabled: boolean;
  dsn: string;
  environment: string | undefined;
  errorsOnly: boolean;
} {
  const dsnOverride = params.dsnOverride?.trim();
  const nodeEnv = params.nodeEnv?.trim().toLowerCase() || undefined;
  const isProduction = nodeEnv === "production" || nodeEnv === "prod";
  const usesDefaultDsn = !dsnOverride;
  return {
    enabled: usesDefaultDsn ? params.analyticsEnabled : true,
    dsn: dsnOverride || params.defaultDsn,
    environment:
      params.environmentOverride?.trim().toLowerCase() ||
      (usesDefaultDsn && isProduction ? SELF_HOSTED_ENVIRONMENT : nodeEnv),
    errorsOnly: usesDefaultDsn,
  };
}

/**
 * Sentry's `dataCollection` option with every collection category off, for
 * every Sentry client (backend, and the Next.js browser, server and edge
 * runtimes).
 *
 * This is Sentry's replacement for the deprecated `sendDefaultPii`, which is
 * removed in SDK v11. Setting `dataCollection` at all switches the SDK's
 * baseline to "collect everything", so each category is listed here; one left
 * out would be collected. With `userInfo` off the SDK also tells Sentry not to
 * infer the sender's IP address.
 *
 * https://docs.sentry.io/platforms/javascript/guides/node/data-management/data-collected/
 */
export const ERROR_REPORTING_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  stackFrameVariables: false,
};

/**
 * Remove private content from an error report, in place.
 *
 * Keeps what groups and explains an error (exception type, stack frames,
 * route, status, tags) and drops request headers, cookies, bodies and query
 * strings, user identity beyond an opaque id, local variables, breadcrumb
 * payloads, and credentials or emails embedded in messages and extra data.
 */
export function scrubErrorReportEvent<T extends object>(event: T): T {
  const report = event as ReportShape;

  // The Node SDK sends the host name, which in Kubernetes is the pod name and
  // so carries the deployment's release name.
  delete report.server_name;

  if (report.request) {
    delete report.request.headers;
    delete report.request.cookies;
    delete report.request.data;
    delete report.request.query_string;
    delete report.request.env;
    if (typeof report.request.url === "string") {
      report.request.url = stripUrlQuery(report.request.url);
    }
  }

  if (report.user) {
    report.user =
      report.user.id !== undefined && report.user.id !== null
        ? { id: report.user.id }
        : {};
  }

  if (typeof report.message === "string") {
    report.message = redactSensitiveText(report.message);
  }
  if (report.logentry) {
    if (typeof report.logentry.message === "string") {
      report.logentry.message = redactSensitiveText(report.logentry.message);
    }
    delete report.logentry.params;
  }

  for (const exception of report.exception?.values ?? []) {
    if (typeof exception.value === "string") {
      exception.value = redactSensitiveText(exception.value);
    }
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }

  if (Array.isArray(report.breadcrumbs)) {
    report.breadcrumbs = report.breadcrumbs.map(scrubErrorReportBreadcrumb);
  }

  if (report.extra) {
    report.extra = scrubValue(report.extra, 0) as Record<string, unknown>;
  }
  if (report.contexts) {
    report.contexts = scrubValue(report.contexts, 0) as Record<string, unknown>;
  }
  // Tags are set by our own code, so their names are trusted; their values
  // can still quote an upstream message.
  if (report.tags) {
    for (const [key, value] of Object.entries(report.tags)) {
      if (typeof value === "string") {
        report.tags[key] = redactSensitiveText(value);
      }
    }
  }

  return event;
}

/**
 * Reduce a breadcrumb to what happened, without its content: console and UI
 * messages are dropped, and request breadcrumbs keep only the method, status
 * and the URL without its query.
 */
export function scrubErrorReportBreadcrumb<T extends object>(breadcrumb: T): T {
  const crumb = breadcrumb as BreadcrumbShape;
  const data: Record<string, unknown> = {};
  for (const key of ["method", "status_code"]) {
    const value = crumb.data?.[key];
    if (typeof value === "string" || typeof value === "number") {
      data[key] = value;
    }
  }
  for (const key of ["url", "from", "to"]) {
    const value = crumb.data?.[key];
    if (typeof value === "string") data[key] = stripUrlQuery(value);
  }
  const scrubbed: BreadcrumbShape = {
    ...(crumb.type !== undefined && { type: crumb.type }),
    ...(crumb.category !== undefined && { category: crumb.category }),
    ...(crumb.level !== undefined && { level: crumb.level }),
    ...(crumb.timestamp !== undefined && { timestamp: crumb.timestamp }),
    ...(Object.keys(data).length > 0 && { data }),
  };
  return scrubbed as T;
}

// === Internal helpers ===

/** Environment tag for a deployment that reports to Archestra's project. */
const SELF_HOSTED_ENVIRONMENT = "self-hosted";
const FILTERED = "[Filtered]";
const MAX_STRING_LENGTH = 2000;
const MAX_DEPTH = 6;

type ReportShape = {
  server_name?: unknown;
  message?: unknown;
  logentry?: { message?: unknown; params?: unknown };
  request?: {
    url?: unknown;
    headers?: unknown;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    env?: unknown;
  };
  user?: { id?: unknown };
  exception?: {
    values?: Array<{
      value?: unknown;
      stacktrace?: { frames?: Array<{ vars?: unknown }> };
    }>;
  };
  breadcrumbs?: object[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
};

type BreadcrumbShape = {
  type?: unknown;
  category?: unknown;
  level?: unknown;
  timestamp?: unknown;
  message?: unknown;
  data?: Record<string, unknown>;
};

/**
 * Keys whose values are credentials (matched anywhere in the key) or
 * conversation and request content (matched as the whole key).
 *
 * The credential terms follow the key names Sentry's SDK and its server-side
 * default scrubbers treat as sensitive, minus the ones that are too short to
 * match safely as a substring ("key", "sid", "sso").
 */
const SECRET_KEY_PATTERN =
  /auth|bearer|cookie|credential|csrf|jwt|passwd|password|private[-_]?key|pwd|api[-_]?key|saml|secret|session|token|xsrf/i;
const CONTENT_KEYS = new Set([
  "arguments",
  "args",
  "body",
  "completion",
  "content",
  "contents",
  "headers",
  "input",
  "inputs",
  "instructions",
  "messages",
  "output",
  "params",
  "prompt",
  "prompts",
  "query",
  "system",
]);

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || CONTENT_KEYS.has(key.toLowerCase());
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    return redacted.length > MAX_STRING_LENGTH
      ? `${redacted.slice(0, MAX_STRING_LENGTH)}…`
      : redacted;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1));
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    scrubbed[key] = isSensitiveKey(key)
      ? FILTERED
      : scrubValue(child, depth + 1);
  }
  return scrubbed;
}

const TEXT_REDACTIONS: Array<[RegExp, string]> = [
  // The ORM appends a failed query's bound values, which can be user data.
  [/(Failed query:[\s\S]*?\nparams:)[\s\S]*/, `$1 ${FILTERED}`],
  // Credentials in a URL's user info, then its query and fragment.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${FILTERED}@`],
  [/(\bhttps?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${FILTERED}`],
  [
    /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
    `$1$2${FILTERED}`,
  ],
  // Provider and platform keys by their published prefixes.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, FILTERED],
  [/\b(?:arch|archestra)_[A-Za-z0-9_-]{16,}/g, FILTERED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, FILTERED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, FILTERED],
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, FILTERED],
  [/\bAKIA[0-9A-Z]{16}\b/g, FILTERED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, FILTERED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, FILTERED],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of TEXT_REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function stripUrlQuery(url: string): string {
  return redactSensitiveText(url.split(/[?#]/)[0]);
}
