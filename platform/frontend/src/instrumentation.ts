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

    const { captureRequestError } = await import("@sentry/nextjs");
    return captureRequestError(...args);
  };
