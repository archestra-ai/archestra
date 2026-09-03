import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { AgentRunTranscriptModel } from "@/models";

export const agentRunTranscriptStore = {
  async persist(params: {
    runId: string;
    transcript: string | null;
    observedBytes: number;
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
};

// ===================== internals =====================

const RAW_CHUNK_BYTES = 256 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
