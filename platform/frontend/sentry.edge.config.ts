// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import {
  getFrontendEdgeSentryOptions,
  getFrontendServerErrorReporting,
} from "./sentry.shared";

const reporting = getFrontendServerErrorReporting();

if (reporting.enabled) {
  Sentry.init(getFrontendEdgeSentryOptions(reporting));
}
