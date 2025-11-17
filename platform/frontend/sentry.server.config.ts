import * as Sentry from "@sentry/nextjs";
import config from "@/lib/config";

const { dsn } = config.sentry;

// Initialize Sentry only if DSN is configured
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    // Performance Monitoring
    tracesSampleRate: 1.0, // Capture 100% of transactions for performance monitoring
    // Consider adjusting this in production
  });
}
