import type {
  ErrorEvent,
  EventHint,
  Integration,
  TracesSamplerSamplingContext,
} from "@sentry/core";
import * as Sentry from "@sentry/node";
import config from "@/config";
import logger from "@/logging";
import { ApiError } from "@/types";
import { isNoiseRoute, isNoisyMcpGatewayGetRoute } from "./utils";

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

    /**
     * Filter out expected client errors (4xx) from being sent to Sentry.
     * These are expected application errors (not found, validation errors, etc.)
     * that don't indicate bugs and would just create noise in Sentry.
     *
     * https://docs.sentry.io/platforms/javascript/configuration/filtering/
     */
    beforeSend(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
      const error = hint.originalException;

      // Filter out ApiError instances with 4xx status codes
      if (error instanceof ApiError) {
        if (error.statusCode >= 400 && error.statusCode < 500) {
          return null;
        }
      }

      // Also check for statusCode property on generic errors (e.g., from Fastify)
      if (
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        typeof error.statusCode === "number" &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      ) {
        return null;
      }

      return event;
    },

    // https://docs.sentry.io/platforms/javascript/configuration/options/#tracesSampler
    tracesSampler: ({ normalizedRequest }: TracesSamplerSamplingContext) => {
      const url = normalizedRequest?.url;
      const method = normalizedRequest?.method;
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
  });

  logger.info(
    { profilingEnabled: !!profilingIntegration },
    "Sentry initialized successfully",
  );
};

// Initialize Sentry (runs at module load)
await initSentry();

export default sentryClient;
