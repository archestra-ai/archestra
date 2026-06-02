import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { InstanceAnalyticsService } from "./instance-analytics";

const analyticsConfig = {
  enabled: true,
  posthog: {
    key: "ph_test",
    host: "https://posthog.example.com",
  },
};

describe("InstanceAnalyticsService", () => {
  let stateDir: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "archestra-analytics-"));
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("captures started and heartbeat once for a new installation", async () => {
    const service = new InstanceAnalyticsService({
      analyticsConfig: {
        ...analyticsConfig,
        stateDir,
      },
      appVersion: "1.2.3",
      createInstanceId: () => "instance-1",
      fetch: fetchMock,
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    await service.trackStartup();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(capturedEventNames()).toEqual([
      "instance_started",
      "instance_heartbeat",
    ]);
    expect(capturedBodies()).toEqual([
      expect.objectContaining({
        api_key: "ph_test",
        distinct_id: "instance-1",
        event: "instance_started",
        properties: {
          app_version: "1.2.3",
          source: "backend",
        },
      }),
      expect.objectContaining({
        api_key: "ph_test",
        distinct_id: "instance-1",
        event: "instance_heartbeat",
        properties: {
          app_version: "1.2.3",
          source: "backend",
        },
      }),
    ]);

    const state = await readState();
    expect(state).toEqual({
      instanceId: "instance-1",
      startedAt: "2026-06-02T12:00:00.000Z",
      lastHeartbeatAt: "2026-06-02T12:00:00.000Z",
    });
  });

  test("does not recapture before the heartbeat window elapses", async () => {
    const firstRun = new InstanceAnalyticsService({
      analyticsConfig: {
        ...analyticsConfig,
        stateDir,
      },
      createInstanceId: () => "instance-1",
      fetch: fetchMock,
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });
    await firstRun.trackStartup();
    fetchMock.mockClear();

    const secondRun = new InstanceAnalyticsService({
      analyticsConfig: {
        ...analyticsConfig,
        stateDir,
      },
      fetch: fetchMock,
      now: () => new Date("2026-06-03T11:59:59.000Z"),
    });
    await secondRun.trackStartup();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("captures heartbeat after 24 hours without recapturing started", async () => {
    const firstRun = new InstanceAnalyticsService({
      analyticsConfig: {
        ...analyticsConfig,
        stateDir,
      },
      createInstanceId: () => "instance-1",
      fetch: fetchMock,
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });
    await firstRun.trackStartup();
    fetchMock.mockClear();

    const secondRun = new InstanceAnalyticsService({
      analyticsConfig: {
        ...analyticsConfig,
        stateDir,
      },
      fetch: fetchMock,
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    await secondRun.trackStartup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedEventNames()).toEqual(["instance_heartbeat"]);
  });

  test("does nothing when analytics is disabled", async () => {
    const service = new InstanceAnalyticsService({
      analyticsConfig: {
        ...analyticsConfig,
        enabled: false,
        stateDir,
      },
      fetch: fetchMock,
    });

    await service.trackStartup();

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
});
