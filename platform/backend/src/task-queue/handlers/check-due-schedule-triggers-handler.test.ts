import { vi } from "vitest";

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

import {
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleCheckDueScheduleTriggers } from "./check-due-schedule-triggers-handler";

// A trigger whose last execution is in the past is due on the next minute tick.
const TWO_MIN_AGO = () => new Date(Date.now() - 120_000);

describe("handleCheckDueScheduleTriggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no triggers are due", async ({
    makeScheduleTrigger,
  }) => {
    // lastExecutedAt = now → next run is a minute out → not due yet.
    const trigger = await makeScheduleTrigger({ lastExecutedAt: new Date() });

    await handleCheckDueScheduleTriggers();

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(
      await ScheduleTriggerRunModel.countByTrigger({
        organizationId: trigger.organizationId,
        triggerId: trigger.id,
      }),
    ).toBe(0);
  });

  test("creates run, marks executed, and enqueues task for due trigger", async ({
    makeScheduleTrigger,
  }) => {
    const trigger = await makeScheduleTrigger({
      lastExecutedAt: TWO_MIN_AGO(),
    });

    await handleCheckDueScheduleTriggers();

    const runs = await ScheduleTriggerRunModel.listByTrigger({
      organizationId: trigger.organizationId,
      triggerId: trigger.id,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].runKind).toBe("due");

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "schedule_trigger_run_execute",
      payload: { runId: runs[0].id, triggerId: trigger.id },
    });

    const reloaded = await ScheduleTriggerModel.findById(trigger.id);
    expect(reloaded?.lastExecutedAt?.getTime()).toBeGreaterThan(
      TWO_MIN_AGO().getTime(),
    );
  });

  test("creates failed run and skips enqueue when task already in flight", async ({
    makeScheduleTrigger,
  }) => {
    const trigger = await makeScheduleTrigger({
      lastExecutedAt: TWO_MIN_AGO(),
    });
    await TaskModel.create({
      taskType: "schedule_trigger_run_execute",
      payload: { triggerId: trigger.id },
      status: "pending",
    });

    await handleCheckDueScheduleTriggers();

    const runs = await ScheduleTriggerRunModel.listByTrigger({
      organizationId: trigger.organizationId,
      triggerId: trigger.id,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toBe("Skipped: previous run was still in progress");

    expect(mockEnqueue).not.toHaveBeenCalled();

    const reloaded = await ScheduleTriggerModel.findById(trigger.id);
    expect(reloaded?.lastExecutedAt?.getTime()).toBeGreaterThan(
      TWO_MIN_AGO().getTime(),
    );
  });

  test("continues processing when one trigger fails", async ({
    makeOrganization,
    makeScheduleTrigger,
  }) => {
    const org = await makeOrganization();
    await makeScheduleTrigger({
      organizationId: org.id,
      lastExecutedAt: TWO_MIN_AGO(),
    });
    await makeScheduleTrigger({
      organizationId: org.id,
      lastExecutedAt: TWO_MIN_AGO(),
    });

    // First run-creation throws; the spy falls back to the real impl afterward.
    const createSpy = vi.spyOn(ScheduleTriggerRunModel, "create");
    createSpy.mockRejectedValueOnce(new Error("DB error"));

    await handleCheckDueScheduleTriggers();

    // One trigger failed, the other still produced an enqueued run.
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const enqueuedRunId = mockEnqueue.mock.calls[0][0].payload.runId;
    const run = await ScheduleTriggerRunModel.findById(enqueuedRunId);
    expect(run).not.toBeNull();
  });
});
