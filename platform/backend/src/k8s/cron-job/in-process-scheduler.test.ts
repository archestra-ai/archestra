import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const mockSchedule = vi.fn();
const mockStop = vi.fn();
const mockStart = vi.fn();
const mockExecuteSync = vi.fn();

vi.mock("node-cron", () => ({
  schedule: (...args: unknown[]) => {
    mockSchedule(...args);
    return { stop: mockStop, start: mockStart };
  },
}));

vi.mock("@/knowledge-base/connector-sync", () => ({
  connectorSyncService: {
    executeSync: (...args: unknown[]) => mockExecuteSync(...args),
  },
}));

vi.mock("@/entrypoints/_shared/log-capture", () => ({
  createCapturingLogger: () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    getLogOutput: () => "",
  }),
}));

describe("InProcessScheduler", () => {
  let scheduler: {
    schedule: (params: { connectorId: string; schedule: string }) => void;
    unschedule: (connectorId: string) => void;
    suspend: (connectorId: string) => void;
    resume: (connectorId: string) => void;
    isScheduled: (connectorId: string) => boolean;
    stopAll: () => void;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("./in-process-scheduler");
    scheduler = mod.inProcessScheduler;
  });

  afterEach(() => {
    scheduler.stopAll();
  });

  describe("schedule", () => {
    test("creates a cron task with the correct schedule", () => {
      scheduler.schedule({
        connectorId: "conn-1",
        schedule: "0 */6 * * *",
      });

      expect(mockSchedule).toHaveBeenCalledWith(
        "0 */6 * * *",
        expect.any(Function),
      );
      expect(scheduler.isScheduled("conn-1")).toBe(true);
    });

    test("replaces existing task when rescheduling same connector", () => {
      scheduler.schedule({
        connectorId: "conn-1",
        schedule: "0 */6 * * *",
      });
      scheduler.schedule({
        connectorId: "conn-1",
        schedule: "0 */12 * * *",
      });

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(mockSchedule).toHaveBeenCalledTimes(2);
      expect(scheduler.isScheduled("conn-1")).toBe(true);
    });

    test("can schedule multiple connectors independently", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.schedule({ connectorId: "conn-2", schedule: "0 */12 * * *" });

      expect(scheduler.isScheduled("conn-1")).toBe(true);
      expect(scheduler.isScheduled("conn-2")).toBe(true);
      expect(mockSchedule).toHaveBeenCalledTimes(2);
    });
  });

  describe("unschedule", () => {
    test("stops and removes a scheduled task", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.unschedule("conn-1");

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(scheduler.isScheduled("conn-1")).toBe(false);
    });

    test("does nothing for unknown connector", () => {
      scheduler.unschedule("unknown");
      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe("suspend", () => {
    test("stops a scheduled task without removing it", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      mockStop.mockClear();

      scheduler.suspend("conn-1");

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(scheduler.isScheduled("conn-1")).toBe(true);
    });

    test("does nothing for unknown connector", () => {
      scheduler.suspend("unknown");
      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe("resume", () => {
    test("restarts a suspended task", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.suspend("conn-1");

      scheduler.resume("conn-1");

      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    test("does nothing for unknown connector", () => {
      scheduler.resume("unknown");
      expect(mockStart).not.toHaveBeenCalled();
    });
  });

  describe("stopAll", () => {
    test("stops all scheduled tasks and clears the map", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.schedule({ connectorId: "conn-2", schedule: "0 */12 * * *" });
      mockStop.mockClear();

      scheduler.stopAll();

      expect(mockStop).toHaveBeenCalledTimes(2);
      expect(scheduler.isScheduled("conn-1")).toBe(false);
      expect(scheduler.isScheduled("conn-2")).toBe(false);
    });
  });

  describe("sync execution", () => {
    test("calls connectorSyncService.executeSync when cron fires", async () => {
      mockExecuteSync.mockResolvedValue({
        runId: "run-1",
        status: "success",
      });

      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });

      // Get the callback that was passed to cron.schedule and invoke it
      const cronCallback = mockSchedule.mock.calls[0][1] as () => void;
      cronCallback();

      // Wait for the async executeSync to complete
      await vi.waitFor(() => {
        expect(mockExecuteSync).toHaveBeenCalledWith(
          "conn-1",
          expect.objectContaining({
            logger: expect.any(Object),
            getLogOutput: expect.any(Function),
          }),
        );
      });
    });

    test("logs error when sync fails without crashing", async () => {
      mockExecuteSync.mockRejectedValue(new Error("sync failed"));

      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });

      const cronCallback = mockSchedule.mock.calls[0][1] as () => void;
      cronCallback();

      await vi.waitFor(() => {
        expect(mockExecuteSync).toHaveBeenCalledWith(
          "conn-1",
          expect.objectContaining({
            logger: expect.any(Object),
            getLogOutput: expect.any(Function),
          }),
        );
      });
    });

    test("auto-continues on partial result", async () => {
      mockExecuteSync
        .mockResolvedValueOnce({ runId: "run-1", status: "partial" })
        .mockResolvedValueOnce({ runId: "run-2", status: "success" });

      vi.useFakeTimers();

      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });

      const cronCallback = mockSchedule.mock.calls[0][1] as () => void;
      cronCallback();

      // Wait for first executeSync call
      await vi.waitFor(() => {
        expect(mockExecuteSync).toHaveBeenCalledTimes(1);
      });

      // Advance timer by 5s to trigger continuation
      await vi.advanceTimersByTimeAsync(5000);

      await vi.waitFor(() => {
        expect(mockExecuteSync).toHaveBeenCalledTimes(2);
      });

      vi.useRealTimers();
    });
  });
});
