import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import { test } from "@/test";
import { verifyConcurrentTranscriptReplacement } from "@/test/agent-transcript-concurrency";

for (const readable of [false, true]) {
  test(`${readable ? "readable" : "terminal"} recording replacements retain a whole snapshot and roll back invalid chunks`, async ({
    makeOrganization,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    const context = await A2AContextModel.create({
      actorKind: "system",
      actorId: "recording-test",
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    const run = await AgentRunModel.create({
      organizationId: organization.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "system",
      actorId: "recording-test",
      workloadName: `recording-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    await verifyConcurrentTranscriptReplacement(run.id, readable);
  });
}
