import type { RetainedLogRecord } from "@/logging/log-ring-buffer";
import { describe, expect, test, vi } from "@/test";
import { PostHogErrorTrackingService } from "./error-tracking";

const enabledAnalyticsConfig = {
  enabled: true,
  posthog: { key: "phc_test", host: "https://posthog.example.com" },
};

function makeFakeClient() {
  return {
    captureException: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe("PostHogErrorTrackingService", () => {
  test("captures an exception with session, distinct id and instance grouping", async () => {
    const client = makeFakeClient();
    const service = new PostHogErrorTrackingService({
      analyticsConfig: enabledAnalyticsConfig,
      appVersion: "1.2.3",
      environment: "production",
      createClient: () => client,
      loadInstanceId: async () => "instance-1",
      getRecentLogs: () => [],
    });
    await service.init();

    const error = new Error("boom");
    service.captureException({
      error,
      distinctId: "user-123",
      sessionId: "session-abc",
      traceId: "trace-1",
      properties: { status_code: 500 },
    });

    expect(client.captureException).toHaveBeenCalledTimes(1);
    const [capturedError, distinctId, properties] =
      client.captureException.mock.calls[0];
    expect(capturedError).toBe(error);
    expect(distinctId).toBe("user-123");
    expect(properties).toMatchObject({
      source: "backend",
      app_version: "1.2.3",
      environment: "production",
      instance_id: "instance-1",
      $groups: { instance: "instance-1" },
      $session_id: "session-abc",
      status_code: 500,
    });
    // Real user error → keep default person processing (no opt-out flag).
    expect(properties).not.toHaveProperty("$process_person_profile");
  });

  test("falls back to the instance id and disables person profiles when anonymous", async () => {
    const client = makeFakeClient();
    const service = new PostHogErrorTrackingService({
      analyticsConfig: enabledAnalyticsConfig,
      createClient: () => client,
      loadInstanceId: async () => "instance-1",
      getRecentLogs: () => [],
    });
    await service.init();

    service.captureException({ error: new Error("boom") });

    const [, distinctId, properties] = client.captureException.mock.calls[0];
    expect(distinctId).toBe("instance-1");
    expect(properties.$process_person_profile).toBe(false);
    expect(properties).not.toHaveProperty("$session_id");
  });

  test("attaches the preceding log lines scoped to the failing trace", async () => {
    const client = makeFakeClient();
    const logs: RetainedLogRecord[] = [
      {
        time: 1_700_000_000_000,
        level: 30,
        levelLabel: "info",
        msg: "starting work",
        traceId: "trace-1",
      },
      {
        time: 1_700_000_000_500,
        level: 50,
        levelLabel: "error",
        msg: "it failed",
        traceId: "trace-1",
      },
    ];
    const getRecentLogs = vi.fn(() => logs);
    const service = new PostHogErrorTrackingService({
      analyticsConfig: enabledAnalyticsConfig,
      createClient: () => client,
      loadInstanceId: async () => null,
      getRecentLogs,
    });
    await service.init();

    service.captureException({ error: new Error("boom"), traceId: "trace-1" });

    expect(getRecentLogs).toHaveBeenCalledWith({
      traceId: "trace-1",
      limit: 30,
    });
    const [, , properties] = client.captureException.mock.calls[0];
    expect(properties.preceding_logs).toEqual([
      {
        time: new Date(1_700_000_000_000).toISOString(),
        level: "info",
        msg: "starting work",
      },
      {
        time: new Date(1_700_000_000_500).toISOString(),
        level: "error",
        msg: "it failed",
      },
    ]);
  });

  test("is a no-op when analytics is disabled", async () => {
    const createClient = vi.fn(makeFakeClient);
    const service = new PostHogErrorTrackingService({
      analyticsConfig: { ...enabledAnalyticsConfig, enabled: false },
      createClient,
      loadInstanceId: async () => "instance-1",
      getRecentLogs: () => [],
    });
    await service.init();

    // No client is constructed, and capture does nothing.
    expect(createClient).not.toHaveBeenCalled();
    expect(() =>
      service.captureException({ error: new Error("boom") }),
    ).not.toThrow();
  });

  test("captures even when the instance id fails to resolve", async () => {
    const client = makeFakeClient();
    const service = new PostHogErrorTrackingService({
      analyticsConfig: enabledAnalyticsConfig,
      createClient: () => client,
      loadInstanceId: async () => {
        throw new Error("db down");
      },
      getRecentLogs: () => [],
    });
    await service.init();

    service.captureException({
      error: new Error("boom"),
      distinctId: "user-1",
    });

    const [, distinctId, properties] = client.captureException.mock.calls[0];
    expect(distinctId).toBe("user-1");
    expect(properties).not.toHaveProperty("instance_id");
    expect(properties).not.toHaveProperty("$groups");
  });

  test("flushes the client on shutdown", async () => {
    const client = makeFakeClient();
    const service = new PostHogErrorTrackingService({
      analyticsConfig: enabledAnalyticsConfig,
      createClient: () => client,
      loadInstanceId: async () => null,
      getRecentLogs: () => [],
    });
    await service.init();

    await service.shutdown();

    expect(client.shutdown).toHaveBeenCalledTimes(1);
    // Subsequent captures are no-ops after shutdown.
    service.captureException({ error: new Error("late") });
    expect(client.captureException).not.toHaveBeenCalled();
  });
});
