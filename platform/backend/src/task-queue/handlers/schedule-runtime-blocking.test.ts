import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { agentRunReconciler } from "@/services/agent-runtime/reconciler";
import { afterEach, expect, test, vi } from "@/test";
import { handleCheckDueScheduleTriggers } from "./check-due-schedule-triggers-handler";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.for([
  false,
  true,
])("a two-day unfinished task still blocks later ticks (prior success: %s)", async (withHistory, {
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const baseline = Date.parse("2030-01-01T00:00:00Z");
  vi.setSystemTime(baseline);
  const trigger = await makeScheduleTrigger({ enabled: false });
  if (withHistory) {
    const successful = await makeScheduleTriggerRun(trigger.id);
    vi.setSystemTime(baseline + 30 * 60_000);
    await ScheduleTriggerRunModel.markCompleted({
      runId: successful.id,
      status: "success",
    });
  }
  const started = Date.now();
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: trigger.actorUserId,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: trigger.agentId,
    state: "TASK_STATE_WORKING",
  });
  const run = await makeScheduleTriggerRun(trigger.id);
  const runtime = await AgentRunModel.create({
    organizationId: trigger.organizationId,
    agentId: trigger.agentId,
    taskId: task.id,
    actorKind: "user",
    actorId: trigger.actorUserId,
    actorUserId: trigger.actorUserId,
    backend: "kubernetes",
    runtimeScope: "test-runtime",
    workloadName: `long-run-${task.id}`,
    activeDeadlineSeconds: 72 * 3600,
  });
  const deadline = new Date(started + 72 * 3_600_000);
  await AgentWorkspaceModel.create({
    organizationId: trigger.organizationId,
    agentId: trigger.agentId,
    actorKind: "user",
    actorId: trigger.actorUserId,
    backend: "kubernetes",
    runtimeScope: "test-runtime",
    workloadName: runtime.workloadName,
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: deadline,
  });
  await ScheduleTriggerRunModel.setRuntimeTaskId({
    runId: run.id,
    taskId: task.id,
  });

  for (const days of [1, 2]) {
    vi.setSystemTime(started + days * 24 * 3_600_000);
    await ScheduleTriggerModel.update(trigger.id, {
      enabled: true,
      lastExecutedAt: new Date(Date.now() - 120_000),
    });
    await handleCheckDueScheduleTriggers();
  }
  expect(
    await TaskModel.hasPendingOrProcessingByType(
      "schedule_trigger_run_execute",
    ),
  ).toBe(false);
  expect(await A2ATaskModel.findById(task.id)).toMatchObject({
    state: "TASK_STATE_WORKING",
  });
  expect(await ScheduleTriggerRunModel.findById(run.id)).toMatchObject({
    status: "running",
    completedAt: null,
  });
  const runs = await ScheduleTriggerRunModel.listByTrigger({
    organizationId: trigger.organizationId,
    triggerId: trigger.id,
  });
  const skipped = runs.filter((candidate) => candidate.status === "failed");
  expect(skipped).toHaveLength(2);
  for (const skip of skipped)
    expect(skip.blockedBy).toMatchObject({
      phase: "running",
      runtimeTaskId: task.id,
      deadline: deadline.toISOString(),
      maximumDurationSeconds: 72 * 3600,
      elapsedSeconds: expect.any(Number),
    });
  expect(
    skipped.every(
      (candidate) =>
        candidate.error?.includes(
          `Skipped: run ${run.id} was still in progress`,
        ) && candidate.blockedBy?.runId === run.id,
    ),
  ).toBe(true);
});

test("workspace expiry stops the task with a specific reason, and the schedule can resume", async ({
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
    state: "TASK_STATE_WORKING",
  });
  const runtimeRun = await AgentRunModel.create({
    organizationId: trigger.organizationId,
    agentId: trigger.agentId,
    taskId: task.id,
    actorKind: "user",
    actorId: trigger.actorUserId,
    actorUserId: trigger.actorUserId,
    backend: "kubernetes",
    runtimeScope: "test-runtime",
    workloadName: `assessment-${task.id}`,
  });
  await AgentWorkspaceModel.create({
    organizationId: trigger.organizationId,
    agentId: trigger.agentId,
    actorKind: "user",
    actorId: trigger.actorUserId,
    backend: "kubernetes",
    runtimeScope: "test-runtime",
    workloadName: runtimeRun.workloadName,
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() - 1000),
  });
  const run = await makeScheduleTriggerRun(trigger.id);
  await ScheduleTriggerRunModel.setRuntimeTaskId({
    runId: run.id,
    taskId: task.id,
  });
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  let acknowledgeStop!: () => void;
  const stopAcknowledged = new Promise<void>((resolve) => {
    acknowledgeStop = resolve;
  });
  const stop = vi.spyOn(backend, "stopRun").mockImplementation(async () => {
    await stopAcknowledged;
    return undefined;
  });
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  vi.spyOn(backend, "snapshotOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("Saved final output");
    },
  );
  const deletion = vi.spyOn(backend, "deleteWorkspace").mockResolvedValue();
  const finalizations: Promise<unknown>[] = [];
  vi.spyOn(backend, "withSessionLease").mockImplementation(
    async (_session, action) => {
      const pending = action();
      finalizations.push(pending);
      await pending;
      return true;
    },
  );
  const reconciliation = agentRunReconciler.reconcile();
  await expect
    .poll(async () => (await A2ATaskModel.findById(task.id))?.state)
    .toBe("TASK_STATE_CANCELED");
  await ScheduleTriggerModel.update(trigger.id, {
    enabled: true,
    lastExecutedAt: new Date(Date.now() - 120_000),
  });
  await handleCheckDueScheduleTriggers();
  expect(
    await TaskModel.hasPendingOrProcessingByType(
      "schedule_trigger_run_execute",
    ),
  ).toBe(false);
  expect(await ScheduleTriggerRunModel.findById(run.id)).toMatchObject({
    status: "running",
  });
  const stopping = (
    await ScheduleTriggerRunModel.listByTrigger({
      organizationId: trigger.organizationId,
      triggerId: trigger.id,
    })
  ).find((candidate) => candidate.id !== run.id);
  expect(stopping).toMatchObject({
    blockedBy: { phase: "stopping", runId: run.id },
    error: expect.stringContaining("cleanup is confirmed"),
  });
  acknowledgeStop();
  await reconciliation;
  await Promise.all(finalizations);
  const reason =
    "The run's workspace reached its retention deadline before the run finished.";
  expect(await A2ATaskModel.findById(task.id)).toMatchObject({
    state: "TASK_STATE_CANCELED",
    statusReason: reason,
  });
  expect(stop).toHaveBeenCalled();
  expect(deletion).toHaveBeenCalledOnce();
  await ScheduleTriggerModel.update(trigger.id, {
    enabled: true,
    lastExecutedAt: new Date(Date.now() - 120_000),
  });
  await handleCheckDueScheduleTriggers();
  expect(await ScheduleTriggerRunModel.findById(run.id)).toMatchObject({
    status: "cancelled",
    error: reason,
  });
  expect(
    await TaskModel.dequeue(["schedule_trigger_run_execute"]),
  ).not.toBeNull();
  expect(await TaskModel.dequeue(["schedule_trigger_run_execute"])).toBeNull();
});
