import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { afterEach, expect, test, vi } from "@/test";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { cleanupAgentRun } from "./pod-run";
import { agentRunReconciler } from "./reconciler";
import { agentRunTranscriptStore } from "./transcript-store";

afterEach(() => vi.restoreAllMocks());

test("expiry retains the workspace until final transcript capture succeeds", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  const run = await AgentRunModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope: "local",
    workloadName: `expiry-${task.id}`,
  });
  await AgentWorkspaceModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    backend: "kubernetes",
    runtimeScope: "local",
    workloadName: run.workloadName,
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() - 1000),
  });
  vi.spyOn(backend, "stopRun").mockResolvedValue();
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  vi.spyOn(backend, "streamOutput").mockImplementation(
    async ({ destination }) => {
      destination.end();
    },
  );
  const snapshot = vi
    .spyOn(backend, "snapshotOutput")
    .mockRejectedValue(new Error("temporary snapshot failure"));
  // Keep the unrelated adoption loop from running a second finalizer in this test.
  vi.spyOn(backend, "withSessionLease").mockResolvedValue(false);
  const deletion = vi
    .spyOn(backend, "deleteWorkspace")
    .mockImplementation(async () => {
      const chunks: Buffer[] = [];
      await agentRunTranscriptStore.stream({
        runId: run.id,
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      });
      expect(Buffer.concat(chunks).toString()).toBe(
        "final output before expiry",
      );
    });
  await agentRunReconciler.reconcile();
  expect((await A2ATaskModel.findById(task.id))?.state).toBe(
    "TASK_STATE_CANCELED",
  );
  expect(deletion).not.toHaveBeenCalled();
  expect(
    (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))?.state,
  ).toBe("deleting");
  snapshot.mockImplementation(async ({ destination }) => {
    destination.end("final output before expiry");
  });
  await agentRunReconciler.reconcile();
  expect(deletion).toHaveBeenCalledTimes(1);
  expect(
    (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))?.state,
  ).toBe("deleted");
});

test.for([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
] as const)("terminal reconciliation retains %s work and cannot delete a newer turn", async (state, {
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state,
  });
  const run = await AgentRunModel.create({
    organizationId: organization.id,
    taskId: task.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    workloadName: `workspace-${task.id}`,
    backend: "kubernetes",
    runtimeScope: "local",
  });
  const workspace = await AgentWorkspaceModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    backend: "kubernetes",
    runtimeScope: "local",
    workloadName: run.workloadName,
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  // Only the externally owned Kubernetes boundary is stubbed. Transcript
  // persistence and ownership transitions use the real model/database path.
  vi.spyOn(backend, "streamOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("partial");
    },
  );
  let stopped = state !== "TASK_STATE_CANCELED";
  vi.spyOn(backend, "snapshotOutput").mockImplementation(
    async ({ destination }) => {
      destination.end(stopped ? "complete first turn" : "partial");
    },
  );
  const teardown = vi.spyOn(backend, "teardown").mockResolvedValue();
  const stop = vi.spyOn(backend, "stopRun").mockImplementation(async () => {
    stopped = true;
  });
  const release = vi.spyOn(backend, "releaseRun").mockResolvedValue();
  await cleanupAgentRun(run);
  expect(teardown).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(state === "TASK_STATE_CANCELED" ? 1 : 0);
  expect(release).toHaveBeenCalledWith(run);
  expect(
    (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))?.state,
  ).toBe("idle");
  const chunks: Buffer[] = [];
  await agentRunTranscriptStore.stream({
    runId: run.id,
    onChunk: (chunk) => {
      chunks.push(chunk);
    },
  });
  expect(Buffer.concat(chunks).toString()).toBe("complete first turn");

  const nextTask = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  await AgentWorkspaceModel.claim({
    id: workspace.id,
    organizationId: organization.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    taskId: nextTask.id,
  });
  vi.mocked(backend.streamOutput).mockImplementation(
    async ({ destination }) => {
      destination.end();
    },
  );
  vi.mocked(backend.snapshotOutput).mockRejectedValue(
    new Error("Pod is unavailable"),
  );
  await cleanupAgentRun(run);
  expect(teardown).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(state === "TASK_STATE_CANCELED" ? 1 : 0);
  expect(
    (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))
      ?.activeTaskId,
  ).toBe(nextTask.id);
  const retained: Buffer[] = [];
  await agentRunTranscriptStore.stream({
    runId: run.id,
    onChunk: (chunk) => {
      retained.push(chunk);
    },
  });
  expect(Buffer.concat(retained).toString()).toBe("complete first turn");
});
