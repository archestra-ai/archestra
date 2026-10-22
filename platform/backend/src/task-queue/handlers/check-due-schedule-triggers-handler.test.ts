import { vi } from "vitest";
import {
  A2AContextModel,
  A2ATaskModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import { afterEach, expect, test } from "@/test";
import { handleCheckDueScheduleTriggers } from "./check-due-schedule-triggers-handler";

afterEach(() => vi.restoreAllMocks());
const due = () => new Date(Date.now() - 120_000);

test("does nothing when no triggers are due", async ({
  makeScheduleTrigger,
}) => {
  const trigger = await makeScheduleTrigger({
    lastExecutedAt: new Date(Date.now() + 3_600_000),
  });
  await handleCheckDueScheduleTriggers();
  expect(
    await TaskModel.hasPendingOrProcessingByType(
      "schedule_trigger_run_execute",
    ),
  ).toBe(false);
  expect(
    await ScheduleTriggerRunModel.countByTrigger({
      organizationId: trigger.organizationId,
      triggerId: trigger.id,
    }),
  ).toBe(0);
});

test("atomically records and queues one run across competing checks and retries", async ({
  makeScheduleTrigger,
}) => {
  const trigger = await makeScheduleTrigger({ lastExecutedAt: due() });
  await Promise.all([
    handleCheckDueScheduleTriggers(),
    handleCheckDueScheduleTriggers(),
  ]);
  await handleCheckDueScheduleTriggers();
  const runs = await ScheduleTriggerRunModel.listByTrigger({
    organizationId: trigger.organizationId,
    triggerId: trigger.id,
  });
  expect(runs).toHaveLength(1);
  const queued = await TaskModel.dequeue(["schedule_trigger_run_execute"]);
  expect(queued?.payload).toEqual({ runId: runs[0].id, triggerId: trigger.id });
  expect(await TaskModel.dequeue(["schedule_trigger_run_execute"])).toBeNull();
});

test("a queued delivery names its blocking run without inventing a deadline", async ({
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const trigger = await makeScheduleTrigger({ lastExecutedAt: due() });
  const earlier = await makeScheduleTriggerRun(trigger.id);
  await TaskModel.create({
    taskType: "schedule_trigger_run_execute",
    payload: { triggerId: trigger.id, runId: earlier.id },
  });
  await handleCheckDueScheduleTriggers();
  const runs = await ScheduleTriggerRunModel.listByTrigger({
    organizationId: trigger.organizationId,
    triggerId: trigger.id,
  });
  expect(runs.find((run) => run.id !== earlier.id)).toMatchObject({
    status: "failed",
    error: expect.stringContaining(
      `Skipped: run ${earlier.id} was queued or starting`,
    ),
    blockedBy: {
      phase: "starting",
      runId: earlier.id,
      deadline: null,
      runtimeTaskId: null,
    },
  });
  await TaskModel.dequeue(["schedule_trigger_run_execute"]);
  expect(await TaskModel.dequeue(["schedule_trigger_run_execute"])).toBeNull();
});

test("a queue write failure rolls back the tick and run so a retry can recover", async ({
  makeScheduleTrigger,
}) => {
  const trigger = await makeScheduleTrigger({ lastExecutedAt: due() });
  // Inject a failed storage call while retaining the real transaction/model graph.
  const failure = vi
    .spyOn(TaskModel, "create")
    .mockRejectedValueOnce(new Error("Temporary queue write failure"));
  await handleCheckDueScheduleTriggers();
  expect(await ScheduleTriggerModel.findById(trigger.id)).toMatchObject({
    lastExecutedAt: trigger.lastExecutedAt,
  });
  expect(
    await ScheduleTriggerRunModel.countByTrigger({
      organizationId: trigger.organizationId,
      triggerId: trigger.id,
    }),
  ).toBe(0);
  failure.mockRestore();
  await handleCheckDueScheduleTriggers();
  expect(
    await TaskModel.dequeue(["schedule_trigger_run_execute"]),
  ).not.toBeNull();
  expect(await TaskModel.dequeue(["schedule_trigger_run_execute"])).toBeNull();
});

test("one failed trigger does not prevent other due triggers from running", async ({
  makeScheduleTrigger,
}) => {
  const first = await makeScheduleTrigger({ lastExecutedAt: due() });
  const second = await makeScheduleTrigger({ lastExecutedAt: due() });
  vi.spyOn(TaskModel, "create").mockRejectedValueOnce(
    new Error("Temporary queue write failure"),
  );
  await handleCheckDueScheduleTriggers();
  const queued = await TaskModel.dequeue(["schedule_trigger_run_execute"]);
  expect([first.id, second.id]).toContain(queued?.payload.triggerId);
  expect(await TaskModel.dequeue(["schedule_trigger_run_execute"])).toBeNull();
});

test.for([
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_INPUT_REQUIRED",
] as const)("reconciles a persisted runtime task in %s after the launch job has ended", async (state, {
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const trigger = await makeScheduleTrigger({ enabled: false });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: trigger.actorUserId,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: trigger.agentId,
    state,
    statusReason: "Execution interrupted",
  });
  const run = await makeScheduleTriggerRun(trigger.id);
  await ScheduleTriggerRunModel.setRuntimeTaskId({
    runId: run.id,
    taskId: task.id,
  });
  await handleCheckDueScheduleTriggers();
  expect(await ScheduleTriggerRunModel.findById(run.id)).toMatchObject(
    state === "TASK_STATE_INPUT_REQUIRED"
      ? { status: "running", completedAt: null }
      : {
          status: state === "TASK_STATE_CANCELED" ? "cancelled" : "failed",
          error: "Execution interrupted",
          completedAt: expect.any(Date),
        },
  );
});
