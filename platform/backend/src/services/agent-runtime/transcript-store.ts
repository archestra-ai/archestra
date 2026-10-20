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
      ? await compressChunks({ runId: params.runId, data, indexSizes: true })
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
   * playback does not begin inside an escape sequence or character (a first
   * chunk without one is sent whole). The last terminal size set at or before
   * that point is sent first, so the tail replays at the recorded geometry;
   * it comes from the sizes indexed when the chunks were stored, so the
   * omitted chunks are not read. Null when nothing complete is stored.
   */
  async streamTail(params: {
    runId: string;
    maxBytes: number;
    onChunk: (chunk: Buffer) => void;
  }): Promise<{ uncompressedBytes: number; omittedBytes: number } | null> {
    const stored = await AgentRunTranscriptModel.findTailByRunId(params);
    if (!stored) return null;
    const total = stored.transcript.uncompressedBytes;
    if (stored.firstSequence === 0) {
      for (const chunk of stored.chunks) {
        params.onChunk(await gunzipAsync(chunk.data));
      }
      return { uncompressedBytes: total, omittedBytes: 0 };
    }

    const marker = await findLastSizeMarker({
      runId: params.runId,
      throughSequence: stored.firstSequence,
    });
    let sent = 0;
    for (const [index, chunk] of stored.chunks.entries()) {
      let data = await gunzipAsync(chunk.data);
      if (index === 0) {
        const lineBreak = data.indexOf(0x0a);
        if (lineBreak !== -1) data = data.subarray(lineBreak + 1);
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

async function compressChunks(params: {
  runId: string;
  data: Buffer;
  /** Index each chunk's last terminal size (terminal recordings only). */
  indexSizes?: boolean;
}) {
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
      // A marker may start in the previous chunk, so the scan takes in as
      // many of its last bytes as a marker can span.
      lastSizeMarker: params.indexSizes
        ? (lastSizeMarker(
            params.data
              .subarray(Math.max(0, offset - SIZE_MARKER_MAX_BYTES + 1), offset)
              .toString("latin1") + raw.toString("latin1"),
          ) ?? "")
        : null,
    });
  }
  return chunks;
}

/** The size marker a recording carries when its terminal resizes. */
const SIZE_MARKER_START = "\u001b]777;archestra-terminal-size=";
const BELL = "\u0007";
const STRING_TERMINATOR = "\u001b\\";
/** The longest marker: the prefix, `<cols>x<rows>` up to 1000 each, ST. */
const SIZE_MARKER_MAX_BYTES =
  SIZE_MARKER_START.length + "1000x1000".length + STRING_TERMINATOR.length;

/**
 * The last size marker in a recording at or before the end of chunk
 * `throughSequence`, from the sizes indexed as the chunks were stored. Chunks
 * stored before sizes were indexed are read back from the nearest, down to
 * the nearest indexed size. Null when the recording sets none there.
 */
async function findLastSizeMarker(params: {
  runId: string;
  throughSequence: number;
}): Promise<string | null> {
  const { indexed, unindexedSequence } =
    await AgentRunTranscriptModel.findLastSizeMarkerIndex(params);
  if (
    unindexedSequence !== null &&
    (!indexed || unindexedSequence > indexed.sequence)
  ) {
    const stop = indexed?.sequence ?? -1;
    for (let sequence = unindexedSequence; sequence > stop; sequence--) {
      const chunk = await AgentRunTranscriptModel.findChunk({
        runId: params.runId,
        sequence,
      });
      if (!chunk) break;
      const marker =
        chunk.lastSizeMarker === null
          ? lastSizeMarker((await gunzipAsync(chunk.data)).toString("latin1"))
          : chunk.lastSizeMarker;
      if (marker) return marker;
    }
  }
  return indexed?.marker ?? null;
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
