import * as Sentry from "@sentry/nextjs";
import config from "@/lib/config";

const { dsn } = config.sentry;

// Initialize Sentry only if DSN is configured
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    // Replay & Performance monitoring
    tracesSampleRate: 1.0,
    // Session Replay
    replaysSessionSampleRate: 0.1, // Sample 10% of sessions
    replaysOnErrorSampleRate: 1.0, // Sample 100% of sessions with errors
  });
}
