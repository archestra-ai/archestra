// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import config from "@/lib/config/config";
import { getFrontendBrowserSentryOptions } from "../sentry.shared";

const {
  sentry: { dsn, environment },
} = config;

// Only initialize Sentry if DSN is configured. The production check comes
// first and is inlined so the bundler folds it to `false` in dev and drops the
// branch with its module edge, keeping the reporting SDK out of dev compiles.
if (process.env.NODE_ENV === "production" && dsn) {
  void import("@sentry/nextjs").then((Sentry) => {
    const browserOptions = getFrontendBrowserSentryOptions({
      dsn,
      environment,
    });

    Sentry.init({
      ...browserOptions,
      // Preserve the default browser integrations and add Replay on top.
      integrations: [
        ...Sentry.getDefaultIntegrations(browserOptions),
        Sentry.replayIntegration(),
      ],
    });
  });
}

export const onRouterTransitionStart: typeof import("@sentry/nextjs").captureRouterTransitionStart =
  (...args) => {
    if (!dsn) return;

    if (process.env.NODE_ENV === "production") {
      void import("@sentry/nextjs").then(({ captureRouterTransitionStart }) => {
        captureRouterTransitionStart(...args);
      });
    }
  };
