import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { AgentRunReadableTranscriptSchema } from "@archestra/shared";
import { AgentRunTranscriptModel } from "@/models";

export const agentRunTranscriptStore = {
  async persist(params: {
    runId: string;
    transcript: string | null;
    observedBytes: number;
    readableTranscript?: string | null;
  }): Promise<void> {
    const data =
      params.transcript === null
        ? null
        : Buffer.from(params.transcript, "utf8");
    const chunks = [];

    if (data) {
      for (let offset = 0; offset < data.length; offset += RAW_CHUNK_BYTES) {
        const raw = data.subarray(offset, offset + RAW_CHUNK_BYTES);
        const compressed = await gzipAsync(raw);
        chunks.push({
          runId: params.runId,
          sequence: chunks.length,
          uncompressedBytes: raw.length,
          compressedBytes: compressed.length,
          data: compressed,
        });
      }
    }

    await AgentRunTranscriptModel.replace({
      runId: params.runId,
      uncompressedBytes: params.observedBytes,
      isComplete: data !== null,
      chunks,
    });

    const readable = parseReadableTranscript(params.readableTranscript);
    if (!readable) {
      await AgentRunTranscriptModel.deleteReadable(params.runId);
      return;
    }
    const readableData = Buffer.from(JSON.stringify(readable), "utf8");
    const readableChunks = await compressChunks({
      runId: params.runId,
      data: readableData,
    });
    await AgentRunTranscriptModel.replaceReadable({
      runId: params.runId,
      provider: readable.provider,
      version: readable.version,
      uncompressedBytes: readableData.length,
      chunks: readableChunks,
    });
  },

  async stream(params: {
    runId: string;
    onChunk: (chunk: Buffer) => void;
  }): Promise<{
    isComplete: boolean;
    uncompressedBytes: number;
  } | null> {
    const stored = await AgentRunTranscriptModel.findByRunId(params.runId);
    if (!stored) return null;

    if (stored.transcript.isComplete) {
      for (const chunk of stored.chunks) {
        params.onChunk(await gunzipAsync(chunk.data));
      }
    }

    return {
      isComplete: stored.transcript.isComplete,
      uncompressedBytes: stored.transcript.uncompressedBytes,
    };
  },

  async streamReadable(params: {
    runId: string;
    onChunk: (chunk: Buffer) => void;
  }): Promise<{
    provider: string;
    version: number;
    uncompressedBytes: number;
  } | null> {
    const stored = await AgentRunTranscriptModel.findReadableByRunId(
      params.runId,
    );
    if (!stored) return null;

    for (const chunk of stored.chunks) {
      params.onChunk(await gunzipAsync(chunk.data));
    }
    return {
      provider: stored.transcript.provider,
      version: stored.transcript.version,
      uncompressedBytes: stored.transcript.uncompressedBytes,
    };
  },
};

// ===================== internals =====================

const RAW_CHUNK_BYTES = 256 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

async function compressChunks(params: { runId: string; data: Buffer }) {
  const chunks = [];
  for (let offset = 0; offset < params.data.length; offset += RAW_CHUNK_BYTES) {
    const raw = params.data.subarray(offset, offset + RAW_CHUNK_BYTES);
    const compressed = await gzipAsync(raw);
    chunks.push({
      runId: params.runId,
      sequence: chunks.length,
      uncompressedBytes: raw.length,
      compressedBytes: compressed.length,
      data: compressed,
    });
  }
  return chunks;
}

function parseReadableTranscript(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = AgentRunReadableTranscriptSchema.safeParse(
      JSON.parse(value),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
