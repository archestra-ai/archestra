import { randomUUID } from "node:crypto";
import { AgentWorkspaceModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("Agent workspace ownership", () => {
  test("honors the Agent idle window and falls back when no Agent remains", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      runtime: {
        image: "test:local",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: 24,
        idleTimeoutMinutes: 5,
      },
    });
    const stale = new Date(Date.now() - 10 * 60_000);
    const rows = [];
    for (const agentId of [agent.id, randomUUID()]) {
      rows.push(
        await AgentWorkspaceModel.create({
          organizationId: org.id,
          agentId,
          actorKind: "system",
          actorId: "test",
          backend: "kubernetes",
          runtimeScope: "test",
          workloadName: `idle-${agentId}`,
          state: "idle",
          lastTaskId: randomUUID(),
          lastActivityAt: stale,
          idleAt: stale,
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      );
    }
    expect(
      (await AgentWorkspaceModel.listForReaping(180)).map((row) => row.id),
    ).toEqual([rows[0].id]);
    expect(
      (await AgentWorkspaceModel.listForReaping(1)).map((row) => row.id),
    ).toEqual(expect.arrayContaining(rows.map((row) => row.id)));
  });

  test("new activity defeats a stale suspension decision without extending the deadline", async () => {
    const taskId = randomUUID();
    const stale = new Date(Date.now() - 3600_000);
    const expiresAt = new Date(Date.now() + 3600_000);
    const workspace = await AgentWorkspaceModel.create({
      organizationId: randomUUID(),
      agentId: randomUUID(),
      actorKind: "system",
      actorId: "test",
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: `workspace-${taskId}`,
      state: "idle",
      lastTaskId: taskId,
      idleAt: stale,
      lastActivityAt: stale,
      expiresAt,
    });
    expect(await AgentWorkspaceModel.listForReaping(1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspace.id })]),
    );
    expect(await AgentWorkspaceModel.recordActivity(workspace.id)).toBe(true);
    expect(
      await AgentWorkspaceModel.transition({
        id: workspace.id,
        from: "idle",
        to: "suspending",
        expectedLastActivityAt: stale,
      }),
    ).toBe(false);
    expect(await AgentWorkspaceModel.listForReaping(1)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspace.id })]),
    );
    expect(
      (await AgentWorkspaceModel.findByWorkloadName(workspace.workloadName))
        ?.expiresAt,
    ).toEqual(expiresAt);
  });

  test("allows only one continuation and rejects a different actor", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: organization.id });
    const firstTask = randomUUID();
    const workspace = await AgentWorkspaceModel.create({
      organizationId: organization.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: `workspace-${firstTask}`,
      activeTaskId: firstTask,
      lastTaskId: firstTask,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await AgentWorkspaceModel.release({
      workloadName: workspace.workloadName,
      taskId: firstTask,
    });
    const request = {
      id: workspace.id,
      organizationId: organization.id,
      actorKind: "user" as const,
      actorId: user.id,
      agentId: agent.id,
    };
    expect(
      await AgentWorkspaceModel.claim({
        ...request,
        actorId: "another-user",
        taskId: randomUUID(),
      }),
    ).toBeNull();
    const claims = await Promise.all([
      AgentWorkspaceModel.claim({ ...request, taskId: randomUUID() }),
      AgentWorkspaceModel.claim({ ...request, taskId: randomUUID() }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean);
    // A late completion from the previous turn cannot release the new owner.
    await AgentWorkspaceModel.release({
      workloadName: workspace.workloadName,
      taskId: firstTask,
    });
    expect(
      (await AgentWorkspaceModel.findByWorkloadName(workspace.workloadName))
        ?.activeTaskId,
    ).toBe(winner?.activeTaskId);
  });

  test("does not admit new work during suspension or after expiry", async () => {
    const taskId = randomUUID();
    const workspace = await AgentWorkspaceModel.create({
      organizationId: randomUUID(),
      agentId: randomUUID(),
      actorKind: "system",
      actorId: "test",
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: `workspace-${taskId}`,
      state: "suspending",
      lastTaskId: taskId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const request = {
      id: workspace.id,
      organizationId: workspace.organizationId,
      actorKind: workspace.actorKind,
      actorId: workspace.actorId,
      agentId: workspace.agentId,
      taskId: randomUUID(),
    };
    expect(await AgentWorkspaceModel.claim(request)).toBeNull();
    await AgentWorkspaceModel.transition({
      id: workspace.id,
      from: "suspending",
      to: "suspended",
    });
    expect(await AgentWorkspaceModel.claim(request)).toBeNull();
    expect(await AgentWorkspaceModel.listForReaping(1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspace.id })]),
    );
  });
});
