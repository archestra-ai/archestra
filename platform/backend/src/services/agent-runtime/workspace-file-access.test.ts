import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { expect, test, vi } from "@/test";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { accessAgentWorkspaceFile } from "./workspace-files";

test("file access rejects other owners and resumes retained storage without an Agent turn", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
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
