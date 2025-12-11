// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Use process.env directly since config module uses next-runtime-env which is not available during build
const dsn = process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN || "";

// Only initialize Sentry if DSN is configured
if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT?.toLowerCase() ||
      process.env.NODE_ENV?.toLowerCase(),

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 1,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
  });
}
