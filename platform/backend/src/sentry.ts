import * as Sentry from "@sentry/node";
import config from "@/config";
import logger from "@/logging";

const {
  api: { name, version },
  observability: {
    sentry: { dsn },
  },
} = config;

// Initialize Sentry only if DSN is configured
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    release: version,
    serverName: name,
    // Setting this option to true will send default PII data to Sentry
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    // Performance Monitoring
    tracesSampleRate: 1.0, // Capture 100% of transactions for performance monitoring
    // Consider adjusting this in production
    // Integrate with logger - send log messages as breadcrumbs
    beforeBreadcrumb(breadcrumb, hint) {
      // You can modify breadcrumbs here if needed
      return breadcrumb;
    },
  });

  // Create a custom stream to forward logs to Sentry as breadcrumbs
  const originalWrite = process.stdout.write.bind(process.stdout);
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
    } catch (e) {
      // Ignore JSON parse errors
    }
    return originalWrite(chunk, encoding, callback);
  }) as typeof process.stdout.write;

  logger.info("Sentry initialized successfully");
} else {
  logger.info("Sentry DSN not configured, skipping Sentry initialization");
}

export default Sentry;
