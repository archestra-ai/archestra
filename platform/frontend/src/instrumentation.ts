const MSW_ENABLED =
  process.env.NEXT_PUBLIC_API_MOCKING === "enabled" &&
  process.env.NODE_ENV !== "production";
const ERROR_REPORTING_DSN =
  process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN || "";

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
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (ERROR_REPORTING_DSN) {
      await import("../sentry.server.config");
    }

    if (MSW_ENABLED) {
      const { ensureMswServerListening } = await import("./mocks/node");
      ensureMswServerListening();
    }
  }

  if (process.env.NEXT_RUNTIME === "edge" && ERROR_REPORTING_DSN) {
    await import("../sentry.edge.config");
  }
}

export const onRequestError: typeof import("@sentry/nextjs").captureRequestError =
  async (...args) => {
    if (!ERROR_REPORTING_DSN) return;
    if (isIgnorableRequestError(args[0])) return;

    const { captureRequestError } = await import("@sentry/nextjs");
    return captureRequestError(...args);
  };
