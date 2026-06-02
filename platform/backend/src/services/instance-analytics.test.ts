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
    config.analytics = originalAnalyticsConfig;
    config.api.version = originalAppVersion;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("captures started and heartbeat once for a new installation", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();

    await instanceAnalyticsService.trackStartup();

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
    expect(state.analyticsInstanceLastHeartbeatAt).toBeInstanceOf(Date);
  });

  test("does not recapture before the heartbeat window elapses", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    await instanceAnalyticsService.trackStartup();
    fetchMock.mockClear();

    await instanceAnalyticsService.trackStartup();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("captures heartbeat after 24 hours without recapturing started", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await instanceAnalyticsService.trackStartup();
    fetchMock.mockClear();

    await OrganizationModel.updateAnalyticsState({
      id: organization.id,
      analyticsInstanceLastHeartbeatAt: new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ),
    });

    await instanceAnalyticsService.trackStartup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedEventNames()).toEqual(["instance_heartbeat"]);
  });

  test("does nothing when analytics is disabled", async () => {
    config.analytics = {
      ...analyticsConfig,
      enabled: false,
    };

    await instanceAnalyticsService.trackStartup();

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
