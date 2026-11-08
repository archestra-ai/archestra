import { getFrontendServerErrorReporting } from "../sentry.shared";

/**
 * Request errors that are benign client disconnects rather than server faults,
 * so reporting them only adds noise. Next.js throws "The destination stream
 * closed early." when the client aborts an in-flight render/RSC prefetch (e.g.
 * navigating away before it finishes). Matched by message substring because
 * Next throws a plain Error with no stable error code.
 */
const IGNORED_REQUEST_ERROR_MESSAGES = ["The destination stream closed early."];

function isIgnorableRequestError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return IGNORED_REQUEST_ERROR_MESSAGES.some((ignored) =>
    message.includes(ignored),
  );
}

export async function register() {
  const reportErrors = getFrontendServerErrorReporting().enabled;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (reportErrors) {
      await import("../sentry.server.config");
    }
    // Every document's <head> reads it; fetch it before the first one asks.
    const { warmDeploymentFavicon } = await import("@/lib/favicon.server");
    warmDeploymentFavicon();
  }

  if (process.env.NEXT_RUNTIME === "edge" && reportErrors) {
    await import("../sentry.edge.config");
  }
}

export const onRequestError: typeof import("@sentry/nextjs").captureRequestError =
  async (...args) => {
    if (!getFrontendServerErrorReporting().enabled) return;
    if (isIgnorableRequestError(args[0])) return;

    const { captureRequestError } = await import("@sentry/nextjs");
    return captureRequestError(...args);
  };
