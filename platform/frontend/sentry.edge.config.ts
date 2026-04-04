// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { getFrontendEdgeSentryOptions } from "./sentry.shared";

// Use process.env directly since config module uses next-runtime-env which is not available during build
const dsn = process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN || "";

// Only initialize Sentry if DSN is configured
if (dsn) {
  Sentry.init(
    getFrontendEdgeSentryOptions({
      dsn,
      environment:
        process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT?.toLowerCase() ||
        process.env.NODE_ENV?.toLowerCase(),
    }),
  );
}
