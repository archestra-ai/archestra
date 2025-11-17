import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import config from "@/config";
import logger from "@/logging";

const {
  api: { name, version },
  environment,
  observability: {
    sentry: { enabled, dsn },
  },
} = config;

let sentryClient: Sentry.NodeClient | undefined;

// Initialize Sentry only if DSN is configured
if (enabled) {
  // https://docs.sentry.io/platforms/javascript/guides/fastify/install/commonjs/
  sentryClient = Sentry.init({
    dsn,
    environment,
    release: version,
    serverName: name,

    // Setting this option to true will send default PII data to Sentry
    // For example, automatic IP address collection on events
    sendDefaultPii: true,

    integrations: [
      // Add our Profiling integration
      nodeProfilingIntegration(),

      // Add Pino integration to send logs to Sentry
      // https://docs.sentry.io/platforms/javascript/guides/fastify/logs/#pino-integration
      Sentry.pinoIntegration(),
    ],

    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for tracing.
    // We recommend adjusting this value in production
    // Learn more at
    // https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#tracesSampleRate
    tracesSampleRate: 1.0,

    // Set profilesSampleRate to 1.0 to profile 100%
    // of sampled transactions.
    // This is relative to tracesSampleRate
    // Learn more at
    // https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#profilesSampleRate
    profilesSampleRate: 1.0,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Disable Sentry's automatic Fastify instrumentation to avoid conflicts
    // We already have our own OpenTelemetry setup in tracing.ts
    skipOpenTelemetrySetup: true,
  });

  // Create a custom stream to forward logs to Sentry as breadcrumbs
  const originalWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: todo
  process.stdout.write = ((chunk: any, encoding?: any, callback?: any) => {
    try {
      if (typeof chunk === "string") {
        const logData = JSON.parse(chunk);
        if (logData.level >= 40) {
          // Error level (40) and above
          Sentry.addBreadcrumb({
            category: "log",
            message: logData.msg || "",
            level:
              logData.level >= 50
                ? "fatal"
                : logData.level >= 40
                  ? "error"
                  : "warning",
            data: logData,
          });
        }
      }
    } catch (_error) {
      // Ignore JSON parse errors
    }
    return originalWrite(chunk, encoding, callback);
  }) as typeof process.stdout.write;

  logger.info("Sentry initialized successfully");
} else {
  logger.info("Sentry DSN not configured, skipping Sentry initialization");
}

export default sentryClient;
