import assert from "node:assert/strict";
import AgentRunTranscriptModel from "@/models/agent-run-transcript";

export async function verifyConcurrentTranscriptReplacement(
  runId: string,
  readable: boolean,
) {
  const snapshots = Array.from({ length: 8 }, (_, index) => {
    const data = Buffer.from(`snapshot-${index}`);
    return {
      runId,
      provider: `provider-${index}`,
      version: index + 1,
      isComplete: index % 2 === 0,
      uncompressedBytes: data.length * (index + 1),
      chunks: Array.from({ length: index + 1 }, (_, sequence) => ({
        runId,
        sequence,
        uncompressedBytes: data.length,
        compressedBytes: data.length,
        data,
      })),
    };
  });
  for (let round = 0; round < 3; round++) {
    const results = await Promise.allSettled(
      snapshots.map((snapshot) =>
        readable
          ? AgentRunTranscriptModel.replaceReadable(snapshot)
          : AgentRunTranscriptModel.replace(snapshot),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    const stored = readable
      ? await AgentRunTranscriptModel.findReadableByRunId(runId)
      : await AgentRunTranscriptModel.findByRunId(runId);
    assert.ok(stored);
    const snapshot = snapshots.find(
      (item) => item.chunks.length === stored.transcript.chunkCount,
    );
    assert.ok(snapshot);
    assert.equal(
      stored.transcript.uncompressedBytes,
      snapshot.uncompressedBytes,
    );
    assert.equal(stored.transcript.compressedBytes, snapshot.uncompressedBytes);
    assert.equal(stored.chunks.length, snapshot.chunks.length);
    assert.deepEqual(
      stored.chunks.map((chunk) => chunk.sequence),
      snapshot.chunks.map((chunk) => chunk.sequence),
    );
    for (const chunk of stored.chunks) {
      assert.deepEqual(chunk.data, snapshot.chunks[chunk.sequence].data);
    }
    if ("provider" in stored.transcript) {
      assert.equal(stored.transcript.provider, snapshot.provider);
      assert.equal(stored.transcript.version, snapshot.version);
    } else {
      assert.equal(stored.transcript.isComplete, snapshot.isComplete);
    }
  }
  const populated = snapshots[3];
  if (readable) await AgentRunTranscriptModel.replaceReadable(populated);
  else await AgentRunTranscriptModel.replace(populated);
  const beforeInvalid = readable
    ? await AgentRunTranscriptModel.findReadableByRunId(runId)
    : await AgentRunTranscriptModel.findByRunId(runId);
  const invalid = {
    ...snapshots[0],
    chunks: [snapshots[0].chunks[0], snapshots[0].chunks[0]],
  };
  await assert.rejects(
    readable
      ? AgentRunTranscriptModel.replaceReadable(invalid)
      : AgentRunTranscriptModel.replace(invalid),
  );
  const afterInvalid = readable
    ? await AgentRunTranscriptModel.findReadableByRunId(runId)
    : await AgentRunTranscriptModel.findByRunId(runId);
  assert.deepEqual(afterInvalid, beforeInvalid);
  const empty = {
    runId,
    provider: "empty",
    version: 1,
    isComplete: true,
    uncompressedBytes: 0,
    chunks: [],
  };
  if (readable) await AgentRunTranscriptModel.replaceReadable(empty);
  else await AgentRunTranscriptModel.replace(empty);
  const stored = readable
    ? await AgentRunTranscriptModel.findReadableByRunId(runId)
    : await AgentRunTranscriptModel.findByRunId(runId);
  assert.ok(stored);
  assert.equal(stored.transcript.chunkCount, 0);
  assert.equal(stored.transcript.compressedBytes, 0);
  assert.equal(stored.transcript.uncompressedBytes, 0);
  assert.deepEqual(stored.chunks, []);
}
