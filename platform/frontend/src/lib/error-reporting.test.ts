import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);

const interactive = vi.hoisted(() => {
  let release: () => void = () => undefined;
  return {
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
});
vi.mock("./app-interactive", () => ({
  appInteractive: { whenIdle: () => interactive.gate },
}));

let errorReporting: typeof import("./error-reporting").errorReporting;
const ON = { dsn: "https://key@errors.example.com/1", environment: "staging" };

describe("errorReporting", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ errorReporting } = await import("./error-reporting"));
  });

  afterEach(() => interactive.release());

  it("does not load the SDK before the app is interactive, then replays what it buffered", async () => {
    errorReporting.start(ON);
    errorReporting.setUser({ id: "first" });
    errorReporting.setUser({ id: "viewer" });
    errorReporting.captureException(new Error("early"));
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("uncaught early") }),
    );
    await Promise.resolve();
    expect(sentry.init).not.toHaveBeenCalled();

    interactive.release();
    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalledTimes(1));

    // Only the latest identity is replayed.
    expect(sentry.setUser).toHaveBeenCalledTimes(1);
    expect(sentry.setUser).toHaveBeenCalledWith({ id: "viewer" });
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "early" }),
      undefined,
    );
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "uncaught early" }),
      undefined,
    );

    // After init, calls go straight through and the early listener is gone.
    errorReporting.captureException(new Error("later"));
    window.dispatchEvent(new ErrorEvent("error", { message: "x" }));
    expect(sentry.captureException).toHaveBeenCalledTimes(3);
  });

  it("never loads the SDK when telemetry is off and drops what was buffered", async () => {
    errorReporting.captureException(new Error("before start"));
    errorReporting.start({ dsn: "", environment: "staging" });
    errorReporting.captureException(new Error("after start"));
    interactive.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
