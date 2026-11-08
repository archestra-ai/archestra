// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// The SDK itself loads after the app is interactive (see lib/error-reporting).

import config from "@/lib/config/config";
import { errorReporting } from "@/lib/error-reporting";

const {
  sentry: { dsnOverride, environmentOverride },
} = config;

errorReporting.start({
  dsnOverride,
  environmentOverride,
  nodeEnv: process.env.NODE_ENV,
});

export const onRouterTransitionStart: typeof import("@sentry/nextjs").captureRouterTransitionStart =
  (...args) => {
    errorReporting.captureRouterTransitionStart(...args);
  };
