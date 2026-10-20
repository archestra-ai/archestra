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
    const chunks = data
      ? await compressChunks({ runId: params.runId, data })
      : [];

    await AgentRunTranscriptModel.replace({
      runId: params.runId,
      uncompressedBytes: params.observedBytes,
      isComplete: data !== null,
      chunks,
    });

    // Terminal-only updates must not erase an existing readable transcript.
    if (params.readableTranscript === undefined) return;
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

  /**
   * The end of a complete recording: whole stored chunks from the last one
   * back until about `maxBytes`, starting after the first line break so
   * playback does not begin inside an escape sequence or character. The last
   * terminal size the omitted part set is sent first, so the tail replays at
   * the recorded geometry. Null when nothing complete is stored.
   */
  async streamTail(params: {
    runId: string;
    maxBytes: number;
    onChunk: (chunk: Buffer) => void;
  }): Promise<{ uncompressedBytes: number; omittedBytes: number } | null> {
    const stored = await AgentRunTranscriptModel.findTailByRunId(params);
    if (!stored?.transcript.isComplete) return null;
    const total = stored.transcript.uncompressedBytes;
    if (stored.firstSequence === 0) {
      for (const chunk of stored.chunks) {
        params.onChunk(await gunzipAsync(chunk.data));
      }
      return { uncompressedBytes: total, omittedBytes: 0 };
    }

    const marker = await findLastSizeMarker({
      runId: params.runId,
      beforeSequence: stored.firstSequence,
    });
    let sent = 0;
    for (const [index, chunk] of stored.chunks.entries()) {
      let data = await gunzipAsync(chunk.data);
      if (index === 0) {
        const lineBreak = data.indexOf(0x0a);
        data =
          lineBreak === -1 ? Buffer.alloc(0) : data.subarray(lineBreak + 1);
        if (marker) params.onChunk(Buffer.from(marker, "latin1"));
      }
      sent += data.length;
      params.onChunk(data);
    }
    return { uncompressedBytes: total, omittedBytes: total - sent };
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

/** The size marker a recording carries when its terminal resizes. */
const SIZE_MARKER_START = "\u001b]777;archestra-terminal-size=";
const BELL = "\u0007";
const STRING_TERMINATOR = "\u001b\\";

/**
 * The last size marker in a recording's chunks before `beforeSequence`,
 * reading back from the nearest; null when the recording sets none there.
 */
async function findLastSizeMarker(params: {
  runId: string;
  beforeSequence: number;
}): Promise<string | null> {
  for (let sequence = params.beforeSequence - 1; sequence >= 0; sequence--) {
    const chunk = await AgentRunTranscriptModel.findChunk({
      runId: params.runId,
      sequence,
    });
    if (!chunk) return null;
    const marker = lastSizeMarker(
      (await gunzipAsync(chunk.data)).toString("latin1"),
    );
    if (marker) return marker;
  }
  return null;
}

/** The last complete size marker in `text` (`…=<cols>x<rows>` and its end). */
function lastSizeMarker(text: string): string | null {
  let start = text.lastIndexOf(SIZE_MARKER_START);
  while (start !== -1) {
    const rest = text.slice(start + SIZE_MARKER_START.length);
    const size = /^\d+x\d+/.exec(rest)?.[0];
    if (size) {
      const after = rest.slice(size.length);
      const end = after.startsWith(BELL)
        ? BELL
        : after.startsWith(STRING_TERMINATOR)
          ? STRING_TERMINATOR
          : null;
      if (end) return `${SIZE_MARKER_START}${size}${end}`;
    }
    start = start === 0 ? -1 : text.lastIndexOf(SIZE_MARKER_START, start - 1);
  }
  return null;
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
