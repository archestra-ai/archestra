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

test("ephemeral runtime readable history omits structured file bodies while preserving ordinary output", async ({
  makeOrganization,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "system",
    actorId: "transcript-files-test",
  });
  const body = Buffer.from("private runtime file bytes").toString("base64");
  const toolContent = {
    content: [
      { type: "image", mimeType: "image/png", data: body },
      { type: "text", text: "File generated" },
    ],
  };
  const readableTranscript = JSON.stringify({
    version: 1,
    provider: "archestra-agent",
    entries: [
      {
        type: "tool_call",
        name: "archestra__post_run_file",
        input: JSON.stringify({ filename: "report.pdf", content_base64: body }),
      },
      {
        type: "tool_call",
        name: "archestra__run_tool",
        input: JSON.stringify({
          tool_name: "archestra__post_run_file",
          tool_args: { filename: "report.pdf", content_base64: body },
        }),
      },
      {
        type: "tool_call",
        name: "inspect_file",
        input: JSON.stringify(toolContent),
      },
      {
        type: "tool_call",
        name: "archestra__start_run",
        input: JSON.stringify({
          attachments: [{ filename: "report.pdf", contentBase64: body }],
        }),
      },
      { type: "tool_result", text: JSON.stringify(toolContent) },
      { type: "tool_result", text: "ordinary tool output" },
      { type: "message", role: "assistant", text: "The report is ready" },
    ],
  });

  for (const ephemeralFiles of [false, true]) {
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
      actorId: "transcript-files-test",
      workloadName: `files-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
      completionTarget: {
        type: "chatops",
        bindingId: crypto.randomUUID(),
        threadId: "123.456",
        ephemeralFiles,
      },
    });
    await agentRunTranscriptStore.persist({
      runId: run.id,
      transcript: "ordinary terminal output",
      observedBytes: 24,
      readableTranscript,
    });
    const chunks: Buffer[] = [];
    await agentRunTranscriptStore.streamReadable({
      runId: run.id,
      onChunk: (chunk) => chunks.push(chunk),
    });
    const stored = Buffer.concat(chunks).toString();
    if (ephemeralFiles) {
      expect(stored).not.toContain(body);
      expect(stored).toContain("Ephemeral file payload omitted");
    } else {
      expect(stored).toBe(readableTranscript);
    }
    for (const text of [
      "File generated",
      "ordinary tool output",
      "The report is ready",
    ]) {
      expect(stored).toContain(text);
    }
    const terminalChunks: Buffer[] = [];
    await agentRunTranscriptStore.stream({
      runId: run.id,
      onChunk: (chunk) => terminalChunks.push(chunk),
    });
    expect(Buffer.concat(terminalChunks).toString()).toBe(
      "ordinary terminal output",
    );
  }
  expect(readableTranscript).toContain(body);
});
