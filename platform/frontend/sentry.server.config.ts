// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { getFrontendServerSentryOptions } from "./sentry.shared";

// Use process.env directly since config module uses next-runtime-env which is not available during build
const dsn = process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN || "";

// Only initialize Sentry if DSN is configured
if (dsn) {
  Sentry.init(
    getFrontendServerSentryOptions({
      dsn,
      environment:
        process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT?.toLowerCase() ||
        process.env.NODE_ENV?.toLowerCase(),
    }),
  );
}
