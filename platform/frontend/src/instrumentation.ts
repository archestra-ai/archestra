const MSW_ENABLED =
  process.env.NEXT_PUBLIC_API_MOCKING === "enabled" &&
  process.env.NODE_ENV !== "production";
const ERROR_REPORTING_DSN =
  process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN || "";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (ERROR_REPORTING_DSN) {
      await import("../sentry.server.config");
    }

    if (MSW_ENABLED) {
      const [{ server }, { isApiRequest }] = await Promise.all([
        import("./mocks/node"),
        import("./mocks/match"),
      ]);
      server.listen({
        onUnhandledRequest(req) {
          if (!isApiRequest(req.url)) return;
          // Track in a process-global registry so the Playwright fixture can
          // fail the test at teardown. Avoid `print.error()` here so SSR keeps
          // running cleanly and the test sees a single, well-formed failure
          // from the fixture rather than a noisy SSR error fallback.
          globalThis.__archestraUnhandledRequests ??= [];
          globalThis.__archestraUnhandledRequests.push(
            `${req.method} ${req.url}`,
          );
        },
      });
    }
  }

  if (process.env.NEXT_RUNTIME === "edge" && ERROR_REPORTING_DSN) {
    await import("../sentry.edge.config");
  }
}

export const onRequestError: typeof import("@sentry/nextjs").captureRequestError =
  async (...args) => {
    if (!ERROR_REPORTING_DSN) return;

    const { captureRequestError } = await import("@sentry/nextjs");
    return captureRequestError(...args);
  };
