import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { expect, test } from "@/test";
import { agentRunTranscriptStore } from "./transcript-store";

test("terminal-only updates preserve readable history; explicit invalidation removes it", async ({
  makeOrganization,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "system",
    actorId: "transcript-test",
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
    actorId: "transcript-test",
    workloadName: `run-${task.id}`,
    backend: "kubernetes",
    runtimeScope: "test",
  });
  const readableTranscript = JSON.stringify({
    version: 1,
    provider: "test",
    entries: [{ type: "message", role: "assistant", text: "Preserve this" }],
  });
  for (const invalid of [null, "not json"]) {
    await agentRunTranscriptStore.persist({
      runId: run.id,
      transcript: "old",
      observedBytes: 3,
      readableTranscript,
    });
    const terminal = "updated output\n".repeat(30_000);
    await agentRunTranscriptStore.persist({
      runId: run.id,
      transcript: terminal,
      observedBytes: Buffer.byteLength(terminal),
    });
    const chunks: Buffer[] = [];
    await agentRunTranscriptStore.streamReadable({
      runId: run.id,
      onChunk: (chunk) => chunks.push(chunk),
    });
    expect(Buffer.concat(chunks).toString()).toBe(readableTranscript);
    const terminalChunks: Buffer[] = [];
    await agentRunTranscriptStore.stream({
      runId: run.id,
      onChunk: (chunk) => terminalChunks.push(chunk),
    });
    expect(Buffer.concat(terminalChunks).toString()).toBe(terminal);
    await agentRunTranscriptStore.persist({
      runId: run.id,
      transcript: "new",
      observedBytes: 3,
      readableTranscript: invalid,
    });
    expect(
      await agentRunTranscriptStore.streamReadable({
        runId: run.id,
        onChunk: () => undefined,
      }),
    ).toBeNull();
  }
});
