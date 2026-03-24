// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import config from "@/lib/config/config";
import { getFrontendBrowserSentryOptions } from "../sentry.shared";

const {
  sentry: { dsn, environment },
} = config;

// Only initialize Sentry if DSN is configured
if (dsn) {
  Sentry.init({
    ...getFrontendBrowserSentryOptions({ dsn, environment }),
    integrations: [Sentry.replayIntegration()],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
