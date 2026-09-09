import { afterEach } from "vitest";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { expect, test, vi } from "@/test";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { accessAgentWorkspaceFile } from "./workspace-files";

afterEach(() => vi.useRealTimers());

test("file access rejects other owners and resumes retained storage without an Agent turn", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  const org = await makeOrganization();
  const owner = await makeUser();
  const stranger = await makeUser();
  const otherOrg = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: owner.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_COMPLETED",
  });
  const run = await AgentRunModel.create({
    organizationId: org.id,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: owner.id,
    actorUserId: owner.id,
    backend: "kubernetes",
    runtimeScope: "local",
    workloadName: `files-${task.id}`,
  });
  await AgentRunModel.close({ id: run.id });
  await AgentWorkspaceModel.create({
    organizationId: org.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: owner.id,
    backend: "kubernetes",
    runtimeScope: "local",
    workloadName: run.workloadName,
    state: "suspended",
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const request = { operation: "read", path: "notes.txt" } as const;
  const resume = vi
    .spyOn(backend, "resumeWorkspace")
    .mockRejectedValueOnce(new Error("temporary cluster failure"))
    .mockResolvedValue(undefined);
  const read = vi.spyOn(backend, "accessWorkspaceFile").mockResolvedValue({
    path: "notes.txt",
    size: 0,
    sha256: "test",
    content_base64: "",
  });
  for (const actor of [
    { kind: "user", id: stranger.id, organizationId: org.id },
    { kind: "user", id: owner.id, organizationId: otherOrg.id },
  ] as const) {
    await expect(
      accessAgentWorkspaceFile({ actor, taskId: task.id, request }),
    ).rejects.toThrow("Workspace not found");
  }
  expect(resume).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await expect(
    accessAgentWorkspaceFile({
      actor: { kind: "user", id: owner.id, organizationId: org.id },
      taskId: task.id,
      request,
    }),
  ).rejects.toThrow("temporary cluster failure");
  expect(
    (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))?.state,
  ).toBe("resuming");
  await expect(
    accessAgentWorkspaceFile({
      actor: { kind: "user", id: owner.id, organizationId: org.id },
      taskId: task.id,
      request,
    }),
  ).resolves.toMatchObject({ path: "notes.txt", size: 0 });
  expect(
    (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))?.state,
  ).toBe("idle");
  expect(await AgentRunModel.listOpen()).toHaveLength(0);
});

for (const finalState of [
  "idle",
  "deleting",
  "suspending",
  "expired",
] as const) {
  test(`concurrent file resumes allow access only while the workspace is retained and running: ${finalState}`, async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    const run = await AgentRunModel.create({
      organizationId: org.id,
      agentId: agent.id,
      taskId: task.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      backend: "kubernetes",
      runtimeScope: "local",
      workloadName: `concurrent-files-${task.id}`,
    });
    const workspace = await AgentWorkspaceModel.create({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      backend: "kubernetes",
      runtimeScope: "local",
      workloadName: run.workloadName,
      state: "suspended",
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const waiting: Array<() => void> = [];
    let notifyFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    let bothStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    vi.spyOn(backend, "resumeWorkspace").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 1) notifyFirstStarted();
          if (waiting.length === 2) bothStarted();
        }),
    );
    const read = vi.spyOn(backend, "accessWorkspaceFile").mockResolvedValue({
      path: "notes.txt",
      size: 0,
      sha256: "test",
      content_base64: "",
    });
    const access = () =>
      accessAgentWorkspaceFile({
        actor: { kind: "user", id: owner.id, organizationId: org.id },
        taskId: task.id,
        request: { operation: "read", path: "notes.txt" },
      });
    const first = access();
    // Database queries may complete out of call order. Establish which request
    // reaches the external resume first before assigning its completion gate.
    const firstResult = Promise.allSettled([first]);
    await firstStarted;
    const second = access();
    // Register rejection handlers before allowing either external resume to finish.
    const results = Promise.allSettled([first, second]);
    await started;
    expect(read).not.toHaveBeenCalled();
    waiting[0]();
    expect((await firstResult)[0].status).toBe("fulfilled");
    expect(read).toHaveBeenCalledTimes(1);
    if (finalState === "expired") {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(workspace.expiresAt.getTime() + 1);
    } else if (finalState !== "idle") {
      await AgentWorkspaceModel.transition({
        id: workspace.id,
        from: "idle",
        to: finalState,
      });
    }
    waiting[1]();
    const settled = await results;
    expect(settled[1].status).toBe(
      finalState === "idle" ? "fulfilled" : "rejected",
    );
    expect(read).toHaveBeenCalledTimes(finalState === "idle" ? 2 : 1);
    expect(
      (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))?.state,
    ).toBe(finalState === "expired" ? "idle" : finalState);
  });
}
