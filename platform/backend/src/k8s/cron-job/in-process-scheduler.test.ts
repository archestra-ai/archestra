import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const mockCronStop = vi.fn();
const mockCronPause = vi.fn();
const mockCronResume = vi.fn();
let mockCronCallback: (() => void) | null = null;

const mockExecuteSync = vi.fn();

vi.mock("croner", () => ({
  Cron: class MockCron {
    constructor(_expression: string, callback: () => void) {
      mockCronCallback = callback;
    }
    stop() {
      mockCronStop();
    }
    pause() {
      mockCronPause();
    }
    resume() {
      mockCronResume();
    }
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
    mockCronCallback = null;
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

      expect(mockCronStop).toHaveBeenCalledTimes(1);
      expect(scheduler.isScheduled("conn-1")).toBe(true);
    });

    test("can schedule multiple connectors independently", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.schedule({ connectorId: "conn-2", schedule: "0 */12 * * *" });

      expect(scheduler.isScheduled("conn-1")).toBe(true);
      expect(scheduler.isScheduled("conn-2")).toBe(true);
    });
  });

  describe("unschedule", () => {
    test("stops and removes a scheduled task", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.unschedule("conn-1");

      expect(mockCronStop).toHaveBeenCalledTimes(1);
      expect(scheduler.isScheduled("conn-1")).toBe(false);
    });

    test("does nothing for unknown connector", () => {
      scheduler.unschedule("unknown");
      expect(mockCronStop).not.toHaveBeenCalled();
    });
  });

  describe("suspend", () => {
    test("pauses a scheduled task without removing it", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });

      scheduler.suspend("conn-1");

      expect(mockCronPause).toHaveBeenCalledTimes(1);
      expect(scheduler.isScheduled("conn-1")).toBe(true);
    });

    test("does nothing for unknown connector", () => {
      scheduler.suspend("unknown");
      expect(mockCronPause).not.toHaveBeenCalled();
    });
  });

  describe("resume", () => {
    test("resumes a suspended task", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.suspend("conn-1");

      scheduler.resume("conn-1");

      expect(mockCronResume).toHaveBeenCalledTimes(1);
    });

    test("does nothing for unknown connector", () => {
      scheduler.resume("unknown");
      expect(mockCronResume).not.toHaveBeenCalled();
    });
  });

  describe("stopAll", () => {
    test("stops all scheduled tasks and clears the map", () => {
      scheduler.schedule({ connectorId: "conn-1", schedule: "0 */6 * * *" });
      scheduler.schedule({ connectorId: "conn-2", schedule: "0 */12 * * *" });
      mockCronStop.mockClear();

      scheduler.stopAll();

      expect(mockCronStop).toHaveBeenCalledTimes(2);
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

      // Invoke the callback that was passed to Cron constructor
      mockCronCallback?.();

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

      mockCronCallback?.();

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

      mockCronCallback?.();

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
