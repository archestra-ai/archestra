import type { TracesSamplerSamplingContext } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import config from "@/config";
import logger from "@/logging";

const {
  api: { version },
  observability: {
    sentry: { enabled, dsn, environment: sentryEnvironment },
  },
} = config;

let sentryClient: Sentry.NodeClient | undefined;

// Initialize Sentry only if DSN is configured
if (enabled) {
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

    integrations: [
      // Add our Profiling integration
      nodeProfilingIntegration(),

      // Add Pino integration to send logs to Sentry
      // https://docs.sentry.io/platforms/javascript/guides/fastify/logs/#pino-integration
      Sentry.pinoIntegration(),
    ],

    /**
     * Set profilesSampleRate to 1.0 to profile 100% of sampled transactions (this is relative to tracesSampleRate)
     * https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#profilesSampleRate
     */
    profilesSampleRate: 1.0,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    /**
     * Disable Sentry's automatic Fastify instrumentation to avoid conflicts
     * We already have our own OpenTelemetry setup in tracing.ts
     * https://docs.sentry.io/platforms/javascript/guides/express/opentelemetry/custom-setup/
     */
    skipOpenTelemetrySetup: true,

    // https://docs.sentry.io/platforms/javascript/configuration/options/#tracesSampler
    tracesSampler: ({ normalizedRequest }: TracesSamplerSamplingContext) => {
      if (
        normalizedRequest?.url?.startsWith("/health") ||
        normalizedRequest?.url?.startsWith("/metrics")
      ) {
        return 0; // Ignore certain transactions
      }
      return 1.0; // Sample 100% of other transactions
    },
  });

  logger.info("Sentry initialized successfully");
} else {
  logger.info("Sentry DSN not configured, skipping Sentry initialization");
}

export default sentryClient;
