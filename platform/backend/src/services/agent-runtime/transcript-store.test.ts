import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentRunTranscriptModel,
} from "@/models";
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

const SIZE = (cols: number, rows: number) =>
  `\u001b]777;archestra-terminal-size=${cols}x${rows}\u0007`;
const CHUNK = 256 * 1024;

async function makeRun(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeAgent: (params: { organizationId: string }) => Promise<{ id: string }>;
}) {
  const organization = await fixtures.makeOrganization();
  const agent = await fixtures.makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "system",
    actorId: "transcript-test",
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_COMPLETED",
  });
  return AgentRunModel.create({
    organizationId: organization.id,
    taskId: task.id,
    agentId: agent.id,
    actorKind: "system",
    actorId: "transcript-test",
    workloadName: `run-${task.id}`,
    backend: "kubernetes",
    runtimeScope: "test",
  });
}

async function readTail(runId: string, maxBytes: number) {
  const chunks: Buffer[] = [];
  const result = await agentRunTranscriptStore.streamTail({
    runId,
    maxBytes,
    onChunk: (chunk) => chunks.push(chunk),
  });
  return { result, output: Buffer.concat(chunks).toString("latin1") };
}

test("a tail replays at the last stored size without reading the omitted chunks, even a size set across a chunk boundary", async ({
  makeOrganization,
  makeAgent,
}) => {
  const run = await makeRun({ makeOrganization, makeAgent });
  // Chunk 0 sets 100x30. A resize to 120x40 starts 10 bytes before the end
  // of chunk 0 and ends in chunk 1. Chunks 2 and 3 set nothing.
  const first = SIZE(100, 30);
  const second = SIZE(120, 40);
  const recording =
    first +
    "x".repeat(CHUNK - first.length - 10) +
    second +
    "line\n".repeat(Math.ceil((2 * CHUNK) / 5)) +
    "done\n";
  await agentRunTranscriptStore.persist({
    runId: run.id,
    transcript: recording,
    observedBytes: Buffer.byteLength(recording),
  });
  const markers = await Promise.all(
    [0, 1, 2, 3].map(
      async (sequence) =>
        (await AgentRunTranscriptModel.findChunk({ runId: run.id, sequence }))
          ?.lastSizeMarker,
    ),
  );
  expect(markers).toEqual([first, second, "", ""]);

  const findChunk = vi.spyOn(AgentRunTranscriptModel, "findChunk");
  const { result, output } = await readTail(run.id, 64 * 1024);
  expect(findChunk).not.toHaveBeenCalled();
  expect(output.startsWith(second)).toBe(true);
  const tail = output.slice(second.length);
  expect(tail.startsWith("line\n")).toBe(true);
  expect(recording.endsWith(tail)).toBe(true);
  expect(result).toEqual({
    uncompressedBytes: Buffer.byteLength(recording),
    omittedBytes: Buffer.byteLength(recording) - Buffer.byteLength(tail),
  });
  findChunk.mockRestore();
});

test("a recording stored before sizes were indexed is read back for its size", async ({
  makeOrganization,
  makeAgent,
}) => {
  const run = await makeRun({ makeOrganization, makeAgent });
  const size = SIZE(90, 24);
  const recording = `${size}${"line\n".repeat(Math.ceil((3 * CHUNK) / 5))}`;
  await agentRunTranscriptStore.persist({
    runId: run.id,
    transcript: recording,
    observedBytes: Buffer.byteLength(recording),
  });
  await db
    .update(schema.agentRunTranscriptChunksTable)
    .set({ lastSizeMarker: null })
    .where(eq(schema.agentRunTranscriptChunksTable.runId, run.id));

  const findChunk = vi.spyOn(AgentRunTranscriptModel, "findChunk");
  const { output } = await readTail(run.id, 64 * 1024);
  expect(findChunk).toHaveBeenCalled();
  expect(output.startsWith(size)).toBe(true);
  expect(output.slice(size.length).startsWith("line\n")).toBe(true);
  findChunk.mockRestore();
});

test("a tail whose first chunk has no line break is sent whole", async ({
  makeOrganization,
  makeAgent,
}) => {
  const run = await makeRun({ makeOrganization, makeAgent });
  const size = SIZE(80, 24);
  const recording = `${size}${"x".repeat(CHUNK * 2 + 1000)}`;
  await agentRunTranscriptStore.persist({
    runId: run.id,
    transcript: recording,
    observedBytes: Buffer.byteLength(recording),
  });
  // The short last chunk does not reach 64 KiB, so the tail starts at the
  // second chunk, which has no line break and is sent whole.
  const { result, output } = await readTail(run.id, 64 * 1024);
  const sentBytes = Buffer.byteLength(recording) - CHUNK;
  expect(output).toBe(`${size}${"x".repeat(sentBytes)}`);
  expect(result).toEqual({
    uncompressedBytes: Buffer.byteLength(recording),
    omittedBytes: CHUNK,
  });
});

test("an incomplete recording has no tail", async ({
  makeOrganization,
  makeAgent,
}) => {
  const run = await makeRun({ makeOrganization, makeAgent });
  await agentRunTranscriptStore.persist({
    runId: run.id,
    transcript: null,
    observedBytes: 5_000_000,
  });
  const { result, output } = await readTail(run.id, 64 * 1024);
  expect(result).toBeNull();
  expect(output).toBe("");
});
