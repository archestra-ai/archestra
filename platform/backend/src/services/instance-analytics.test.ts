import config from "@/config";
import { OrganizationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { OrganizationAnalyticsState } from "@/types";
import { instanceAnalyticsService } from "./instance-analytics";

const analyticsConfig = {
  enabled: true,
  posthog: {
    key: "ph_test",
    host: "https://posthog.example.com",
  },
};

describe("instanceAnalyticsService", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const originalAnalyticsConfig = config.analytics;
  const originalAppVersion = config.api.version;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    config.analytics = {
      ...analyticsConfig,
    };
    config.api.version = "1.2.3";
  });

  afterEach(() => {
    instanceAnalyticsService.stop();
    config.analytics = originalAnalyticsConfig;
    config.api.version = originalAppVersion;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("captures started and heartbeat for a new installation", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();

    await instanceAnalyticsService.start();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(capturedEventNames()).toEqual([
      "instance_started",
      "instance_heartbeat",
    ]);

    const state = await getAnalyticsState(organization.id);
    expect(capturedBodies()).toEqual([
      expect.objectContaining({
        api_key: "ph_test",
        distinct_id: state.analyticsInstanceId,
        event: "instance_started",
        properties: {
          $groups: {
            instance: state.analyticsInstanceId,
          },
          app_version: "1.2.3",
          instance_id: state.analyticsInstanceId,
          source: "backend",
        },
      }),
      expect.objectContaining({
        api_key: "ph_test",
        distinct_id: state.analyticsInstanceId,
        event: "instance_heartbeat",
        properties: {
          $groups: {
            instance: state.analyticsInstanceId,
          },
          app_version: "1.2.3",
          instance_id: state.analyticsInstanceId,
          source: "backend",
        },
      }),
    ]);
    expect(state.analyticsInstanceId).toEqual(expect.any(String));
    expect(state.analyticsInstanceStartedAt).toBeInstanceOf(Date);
  });

  test("resends the heartbeat but not started on restart", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    await instanceAnalyticsService.start();
    instanceAnalyticsService.stop();
    fetchMock.mockClear();

    await instanceAnalyticsService.start();

    expect(capturedEventNames()).toEqual(["instance_heartbeat"]);
  });

  test("sends a heartbeat every hour while the process stays up", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    vi.useFakeTimers();
    try {
      await instanceAnalyticsService.start();
      expect(capturedEventNames()).toEqual([
        "instance_started",
        "instance_heartbeat",
      ]);
      fetchMock.mockClear();

      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);

      expect(capturedEventNames()).toEqual([
        "instance_heartbeat",
        "instance_heartbeat",
        "instance_heartbeat",
      ]);
    } finally {
      instanceAnalyticsService.stop();
      vi.useRealTimers();
    }
  });

  test("recovers on a later check when the startup capture fails", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValueOnce(new Error("network down"));
      await expect(instanceAnalyticsService.start()).rejects.toThrow(
        "network down",
      );
      fetchMock.mockClear();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(capturedEventNames()).toEqual([
        "instance_started",
        "instance_heartbeat",
      ]);
    } finally {
      instanceAnalyticsService.stop();
      vi.useRealTimers();
    }
  });

  test("does nothing when analytics is disabled", async () => {
    config.analytics = {
      ...analyticsConfig,
      enabled: false,
    };

    await instanceAnalyticsService.start();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  function capturedEventNames(): string[] {
    return capturedBodies().map((body) => String(body.event));
  }

  function capturedBodies(): Record<string, unknown>[] {
    return fetchMock.mock.calls.map(([, init]) => {
      if (!init?.body) throw new Error("Expected capture request body");
      return JSON.parse(String(init.body));
    });
  }

  async function getAnalyticsState(
    id: string,
  ): Promise<OrganizationAnalyticsState> {
    const state = await OrganizationModel.getAnalyticsState();
    expect(state.id).toBe(id);
    return state;
  }
});
