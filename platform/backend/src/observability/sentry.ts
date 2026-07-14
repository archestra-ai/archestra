import type {
  ErrorEvent,
  EventHint,
  Integration,
  TracesSamplerSamplingContext,
} from "@sentry/core";
import * as Sentry from "@sentry/node";
import config from "@/config";
import logger from "@/logging";
import { classifyErrorForTracking } from "./error-tracking-policy";
import {
  isNoiseRoute,
  isNoisyMcpGatewayGetRoute,
  isNoisyTransactionName,
} from "./utils";

const {
  api: { version },
  observability: {
    sentry: {
      enabled,
      dsn,
      environment: sentryEnvironment,
      tracesSampleRate,
      mcpGatewayTracesSampleRate,
      profilesSampleRate,
    },
  },
} = config;

/**
 * Build the Error object reported for a raw upstream-provider failure.
 *
 * The upstream HTTP status is attached to the Error so the {@link filterErrorEvent}
 * 4xx filter drops expected provider CLIENT errors (rate limits, invalid
 * credentials, provider-side content blocks) as noise, while genuine provider
 * 5xx failures still report.
 * @public — exported for testability
 */
export function buildRawProviderError(params: {
  statusCode: number | undefined;
  errorMessage: string;
}): Error {
  const error = new Error(params.errorMessage);
  error.name = "RawProviderError";
  if (params.statusCode !== undefined) {
    (error as Error & { statusCode?: number }).statusCode = params.statusCode;
  }
  return error;
}

export function captureRawProviderErrorInSentry(params: {
  provider: string;
  statusCode: number | undefined;
  parsedError: unknown;
  errorCode: string;
  errorMessage: string;
  errorType: string | undefined;
  rawErrorJson: string;
}): void {
  const error = buildRawProviderError({
    statusCode: params.statusCode,
    errorMessage: params.errorMessage,
  });

  Sentry.captureException(error, {
    level: "error",
    fingerprint: [
      "chat-provider-error-raw-error-json",
      params.provider,
      String(params.statusCode ?? "unknown"),
      params.errorCode,
    ],
    tags: {
      provider: params.provider,
      mapped_code: params.errorCode,
      raw_error_json: "true",
      ...(params.statusCode !== undefined
        ? { status_code: String(params.statusCode) }
        : {}),
      ...(params.errorType ? { error_type: params.errorType } : {}),
    },
    extra: {
      parsedError: params.parsedError,
      errorMessage: params.errorMessage,
      rawErrorJson: params.rawErrorJson,
    },
  });
}

/**
 * Sentry `beforeSend` filter. Delegates the drop/keep-and-group decision to the
 * sink-agnostic {@link classifyErrorForTracking} policy (shared with the PostHog
 * capture path), then applies the result in Sentry's shape: return null to drop,
 * or set the event's fingerprint/tags to group an availability incident.
 *
 * https://docs.sentry.io/platforms/javascript/configuration/filtering/
 * @public — exported for testability
 */
export function filterErrorEvent(
  event: ErrorEvent,
  hint: EventHint,
): ErrorEvent | null {
  const decision = classifyErrorForTracking(hint.originalException);
  if (!decision.report) {
    return null;
  }
  if (decision.fingerprint) {
    event.fingerprint = decision.fingerprint;
  }
  if (decision.tags) {
    event.tags = { ...event.tags, ...decision.tags };
  }
  return event;
}

/**
 * Safely load the profiling integration.
 * The @sentry/profiling-node package contains native bindings that can fail to load
 * on some systems (particularly Windows or certain Mac configurations).
 * We gracefully handle this by returning null if loading fails.
 */
const getProfilingIntegration = async (): Promise<Integration | null> => {
  try {
    // Dynamic import to catch loading errors for native module
    const { nodeProfilingIntegration } = await import("@sentry/profiling-node");
    return nodeProfilingIntegration();
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to load Sentry profiling integration - profiling will be disabled",
    );
    return null;
  }
};

let sentryClient: Sentry.NodeClient | undefined;

/**
 * Initialize Sentry asynchronously to handle dynamic profiling import.
 * This is an IIFE that runs at module load time.
 */
const initSentry = async (): Promise<void> => {
  if (!enabled) {
    logger.info("Sentry DSN not configured, skipping Sentry initialization");
    return;
  }

  const profilingIntegration = await getProfilingIntegration();

  // Build integrations array, only including profiling if it loaded successfully
  const integrations: Integration[] = [
    // Add Pino integration to send logs to Sentry
    // https://docs.sentry.io/platforms/javascript/guides/fastify/logs/#pino-integration
    Sentry.pinoIntegration(),
  ];

  if (profilingIntegration) {
    integrations.unshift(profilingIntegration);
  }

  // https://docs.sentry.io/platforms/javascript/guides/fastify/install/commonjs/
  sentryClient = Sentry.init({
    dsn,
    environment: sentryEnvironment,
    release: version,

    /**
     * Setting this option to true will send default PII data to Sentry
     * For example, automatic IP address collection on events
     * https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#sendDefaultPii
     */
    sendDefaultPii: true,

    integrations,

    /**
     * Set profilesSampleRate to 1.0 to profile 100% of sampled transactions (this is relative to tracesSampleRate)
     * Only effective if profiling integration loaded successfully
     * https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#profilesSampleRate
     */
    profilesSampleRate: profilingIntegration ? profilesSampleRate : 0,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    /**
     * Disable Sentry's automatic Fastify instrumentation to avoid conflicts
     * We already have our own OpenTelemetry setup in tracing.ts
     * https://docs.sentry.io/platforms/javascript/guides/express/opentelemetry/custom-setup/
     */
    skipOpenTelemetrySetup: true,

    beforeSend: filterErrorEvent,

    // https://docs.sentry.io/platforms/javascript/configuration/options/#tracesSampler
    tracesSampler: ({
      normalizedRequest,
      name: transactionName,
    }: TracesSamplerSamplingContext) => {
      const url = normalizedRequest?.url;
      const method = normalizedRequest?.method;

      if (transactionName && isNoisyTransactionName(transactionName)) {
        return 0;
      }

      if (!url) return tracesSampleRate;

      if (isNoiseRoute(url)) {
        return 0;
      }

      // MCP gateway GET discovery/polling traffic dominates span volume and has low debugging value.
      if (method && isNoisyMcpGatewayGetRoute({ method, url })) {
        return 0;
      }

      // Sample remaining MCP gateway traffic much more conservatively than normal app routes.
      if (url.startsWith("/v1/mcp")) {
        return mcpGatewayTracesSampleRate;
      }

      return tracesSampleRate;
    },

    beforeSendTransaction(event) {
      if (event.transaction && isNoisyTransactionName(event.transaction)) {
        return null;
      }

      return event;
    },
  });

  logger.info(
    { profilingEnabled: !!profilingIntegration },
    "Sentry initialized successfully",
  );
};

// Initialize Sentry (runs at module load)
await initSentry();

export default sentryClient;
