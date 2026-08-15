import { beforeEach, describe, expect, it, vi } from "vitest";

const captureRequestError = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureRequestError: (...args: unknown[]) => captureRequestError(...args),
}));

describe("onRequestError filtering", () => {
  beforeEach(() => {
    vi.resetModules();
    captureRequestError.mockClear();
    process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN =
      "https://example.ingest.test";
    // Reporting is off on local environments, and the test runner is one, so
    // the deployed case has to say so explicitly.
    process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT = "staging";
  });

  async function loadHook() {
    const mod = await import("./instrumentation");
    return mod.onRequestError;
  }

  it("does not report the benign 'destination stream closed early' abort", async () => {
    const onRequestError = await loadHook();

    await onRequestError(
      new Error("The destination stream closed early."),
      {} as never,
      {} as never,
    );

    expect(captureRequestError).not.toHaveBeenCalled();
  });

  it("reports genuine request errors", async () => {
    const onRequestError = await loadHook();
    const error = new Error("Cannot read properties of undefined");

    await onRequestError(error, {} as never, {} as never);

    expect(captureRequestError).toHaveBeenCalledTimes(1);
    expect(captureRequestError).toHaveBeenCalledWith(error, {}, {});
  });

  it("skips reporting entirely when no DSN is configured", async () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN = "";
    const onRequestError = await loadHook();

    await onRequestError(
      new Error("Cannot read properties of undefined"),
      {} as never,
      {} as never,
    );

    expect(captureRequestError).not.toHaveBeenCalled();
  });

  // A developer with the DSN in their local env file otherwise reported into
  // the same project as the deployments, with their own absolute paths in the
  // frames.
  it("skips reporting from a local development environment", async () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT = "development";
    const onRequestError = await loadHook();

    await onRequestError(
      new Error("Cannot read properties of undefined"),
      {} as never,
      {} as never,
    );

    expect(captureRequestError).not.toHaveBeenCalled();
  });
});
