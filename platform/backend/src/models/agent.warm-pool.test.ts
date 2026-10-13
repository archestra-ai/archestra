import { A2AContextModel, A2ATaskModel, AgentModel, AgentRunModel } from "@/models";
import { expect, test } from "@/test";

test("warm pool candidates are the Agents run recently, most recent first", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const runtime = {
    image: "test:local",
    command: null,
    inferenceProtocol: "openai_responses" as const,
    backend: "kubernetes" as const,
    steerMode: "pipe" as const,
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: 24,
    idleTimeoutMinutes: 5,
  };
  // Created first, so the old ordering would have given it a pool.
  const idle = await makeAgent({ organizationId: org.id, runtime });
  const stale = await makeAgent({ organizationId: org.id, runtime });
  const earlier = await makeAgent({ organizationId: org.id, runtime });
  const latest = await makeAgent({ organizationId: org.id, runtime });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const now = Date.now();
  const since = new Date(now - 7 * 24 * 3600_000);
  for (const [agentId, startedAt] of [
    [stale.id, new Date(now - 8 * 24 * 3600_000)],
    [earlier.id, new Date(now - 3600_000)],
    [latest.id, new Date(now - 60_000)],
    [earlier.id, new Date(now - 2 * 3600_000)],
  ] as const) {
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId,
      state: "TASK_STATE_WORKING",
    });
    await AgentRunModel.create({
      organizationId: org.id,
      taskId: task.id,
      agentId,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      workloadName: `run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
      startedAt,
    });
  }

  const candidates = await AgentModel.listWarmPoolCandidates({ since });

  expect(candidates.map(({ id }) => id)).toEqual([latest.id, earlier.id]);
  expect(candidates.map(({ id }) => id)).not.toContain(idle.id);
});
