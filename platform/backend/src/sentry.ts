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
    // Performance Monitoring
    tracesSampleRate: 1.0, // Capture 100% of transactions for performance monitoring
    // Consider adjusting this in production
  });

  logger.info("Sentry initialized successfully");
} else {
  logger.info("Sentry DSN not configured, skipping Sentry initialization");
}

export default Sentry;
