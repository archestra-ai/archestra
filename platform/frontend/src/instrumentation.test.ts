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
});
