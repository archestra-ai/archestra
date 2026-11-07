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
const OWN_DSN = {
  dsnOverride: "https://key@errors.example.com/1",
  environmentOverride: "staging",
  nodeEnv: "production",
};
const DEFAULT_DSN = {
  dsnOverride: undefined,
  environmentOverride: undefined,
  nodeEnv: "production",
};

async function settle() {
  interactive.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("errorReporting", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ errorReporting } = await import("./error-reporting"));
  });

  afterEach(() => interactive.release());

  it("does not load the SDK before the app is interactive, then replays what it buffered", async () => {
    errorReporting.start(OWN_DSN);
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

  it("reports to a deployment's own DSN with tracing, whatever the analytics setting", async () => {
    errorReporting.start(OWN_DSN);
    errorReporting.setAnalyticsEnabled(false);
    await settle();

    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: OWN_DSN.dsnOverride,
        environment: "staging",
        tracesSampleRate: expect.any(Number),
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
      }),
    );
  });

  it("waits for analytics, then reports errors only to Archestra's project", async () => {
    errorReporting.start(DEFAULT_DSN);
    errorReporting.captureException(new Error("early"));
    await settle();
    expect(sentry.init).not.toHaveBeenCalled();

    errorReporting.setAnalyticsEnabled(true);
    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalledTimes(1));

    const options = sentry.init.mock.calls[0][0];
    expect(options).toMatchObject({
      dsn: expect.stringMatching(/\.sentry\.io\//),
      environment: "self-hosted",
      sendDefaultPii: false,
      tracePropagationTargets: [],
    });
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.enableLogs).toBeUndefined();
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "early" }),
      undefined,
    );
  });

  it("never loads the SDK when the deployment opts out of analytics, and drops what was buffered", async () => {
    errorReporting.captureException(new Error("before start"));
    errorReporting.start(DEFAULT_DSN);
    errorReporting.captureException(new Error("after start"));
    errorReporting.setAnalyticsEnabled(false);
    errorReporting.setAnalyticsEnabled(true);
    await settle();

    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("never reports from a local development build", async () => {
    errorReporting.start({ ...DEFAULT_DSN, nodeEnv: "development" });
    errorReporting.setAnalyticsEnabled(true);
    await settle();

    expect(sentry.init).not.toHaveBeenCalled();
  });
});
