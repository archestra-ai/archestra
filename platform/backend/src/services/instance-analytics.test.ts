import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { instanceAnalyticsService } from "./instance-analytics";

const analyticsConfig = {
  enabled: true,
  posthog: {
    key: "ph_test",
    host: "https://posthog.example.com",
  },
};

describe("instanceAnalyticsService", () => {
  let stateDir: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const originalAnalyticsConfig = config.analytics;
  const originalAppVersion = config.api.version;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "archestra-analytics-"));
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    config.analytics = {
      ...analyticsConfig,
      stateDir,
    };
    config.api.version = "1.2.3";
  });

  afterEach(() => {
    config.analytics = originalAnalyticsConfig;
    config.api.version = originalAppVersion;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("captures started and heartbeat once for a new installation", async () => {
    await instanceAnalyticsService.trackStartup();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(capturedEventNames()).toEqual([
      "instance_started",
      "instance_heartbeat",
    ]);

    const state = await readState();
    expect(capturedBodies()).toEqual([
      expect.objectContaining({
        api_key: "ph_test",
        distinct_id: state.instanceId,
        event: "instance_started",
        properties: {
          app_version: "1.2.3",
          source: "backend",
        },
      }),
      expect.objectContaining({
        api_key: "ph_test",
        distinct_id: state.instanceId,
        event: "instance_heartbeat",
        properties: {
          app_version: "1.2.3",
          source: "backend",
        },
      }),
    ]);
    expect(state).toEqual({
      instanceId: expect.any(String),
      startedAt: expect.any(String),
      lastHeartbeatAt: expect.any(String),
    });
  });

  test("does not recapture before the heartbeat window elapses", async () => {
    await instanceAnalyticsService.trackStartup();
    fetchMock.mockClear();

    await instanceAnalyticsService.trackStartup();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("captures heartbeat after 24 hours without recapturing started", async () => {
    await instanceAnalyticsService.trackStartup();
    fetchMock.mockClear();

    const state = await readState();
    await writeState({
      ...state,
      lastHeartbeatAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });

    await instanceAnalyticsService.trackStartup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedEventNames()).toEqual(["instance_heartbeat"]);
  });

  test("does nothing when analytics is disabled", async () => {
    config.analytics = {
      ...analyticsConfig,
      enabled: false,
      stateDir,
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

  async function readState(): Promise<Record<string, unknown>> {
    const contents = await readFile(
      path.join(stateDir, "instance-analytics.json"),
      "utf-8",
    );
    return JSON.parse(contents);
  }

  async function writeState(state: Record<string, unknown>): Promise<void> {
    await writeFile(
      path.join(stateDir, "instance-analytics.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf-8",
    );
  }
});
