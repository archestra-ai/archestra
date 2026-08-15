// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import config from "@/lib/config/config";
import {
  getFrontendBrowserSentryOptions,
  shouldEnableFrontendTelemetry,
} from "../sentry.shared";

const {
  sentry: { dsn, environment },
} = config;

const telemetryEnabled = shouldEnableFrontendTelemetry({ dsn, environment });

if (telemetryEnabled) {
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
    if (!telemetryEnabled) return;

    void import("@sentry/nextjs").then(({ captureRouterTransitionStart }) => {
      captureRouterTransitionStart(...args);
    });
  };
