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

/**
 * The `process.env.NODE_ENV === "production"` guards below are written inline
 * (not hoisted into a const) and placed first in each condition so the bundler
 * folds them to a literal `false` in dev and drops the branch — along with its
 * module edge — instead of following it. Without that, every dev route compile
 * walks into the error-reporting server package and drags the OpenTelemetry /
 * Fastify instrumentation graph in with it. Reporting is production-only
 * anyway, and next.config.ts already skips the build-time plugin in dev.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NODE_ENV === "production" && ERROR_REPORTING_DSN) {
      await import("../sentry.server.config");
    }

    if (MSW_ENABLED) {
      const { ensureMswServerListening } = await import("./mocks/node");
      ensureMswServerListening();
    }
  }

  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_RUNTIME === "edge" &&
    ERROR_REPORTING_DSN
  ) {
    await import("../sentry.edge.config");
  }
}

// The annotation is a `typeof import(...)` type expression — erased at compile
// time, so it carries no module edge of its own.
export const onRequestError: typeof import("@sentry/nextjs").captureRequestError =
  async (...args) => {
    if (!ERROR_REPORTING_DSN) return;
    if (isIgnorableRequestError(args[0])) return;

    if (process.env.NODE_ENV === "production") {
      const { captureRequestError } = await import("@sentry/nextjs");
      return captureRequestError(...args);
    }
  };
