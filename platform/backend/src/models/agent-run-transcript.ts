import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AgentRunReadableTranscriptChunk,
  AgentRunReadableTranscriptRecord,
  AgentRunTranscript,
  AgentRunTranscriptChunk,
  InsertAgentRunReadableTranscriptChunk,
  InsertAgentRunTranscriptChunk,
} from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

export default class AgentRunTranscriptModel {
  static async replace(params: {
    runId: string;
    uncompressedBytes: number;
    isComplete: boolean;
    chunks: InsertAgentRunTranscriptChunk[];
  }): Promise<void> {
    const compressedBytes = params.chunks.reduce(
      (total, chunk) => total + chunk.compressedBytes,
      0,
    );

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.agentRunTranscriptsTable)
        .where(eq(schema.agentRunTranscriptsTable.runId, params.runId));
      await tx.insert(schema.agentRunTranscriptsTable).values({
        runId: params.runId,
        uncompressedBytes: params.uncompressedBytes,
        compressedBytes,
        chunkCount: params.chunks.length,
        isComplete: params.isComplete,
      });
      if (params.chunks.length > 0) {
        await tx
          .insert(schema.agentRunTranscriptChunksTable)
          .values(params.chunks);
      }
    });
  }

  static async findByRunId(runId: string): Promise<{
    transcript: AgentRunTranscript;
    chunks: AgentRunTranscriptChunk[];
  } | null> {
    const [transcript] = await db
      .select()
      .from(schema.agentRunTranscriptsTable)
      .where(eq(schema.agentRunTranscriptsTable.runId, runId))
      .limit(1);
    if (!transcript) return null;

    const chunks = await db
      .select()
      .from(schema.agentRunTranscriptChunksTable)
      .where(eq(schema.agentRunTranscriptChunksTable.runId, runId))
      .orderBy(asc(schema.agentRunTranscriptChunksTable.sequence));

    return {
      transcript,
      chunks: chunks.map((chunk) => normalizeByteaField(chunk, "data")),
    };
  }

  /**
   * A complete recording's header and its last chunks, enough for about
   * `maxBytes` of output, without reading the earlier chunks' data. Null when
   * nothing complete is stored.
   */
  static async findTailByRunId(params: {
    runId: string;
    maxBytes: number;
  }): Promise<{
    transcript: AgentRunTranscript;
    chunks: AgentRunTranscriptChunk[];
    firstSequence: number;
  } | null> {
    const [transcript] = await db
      .select()
      .from(schema.agentRunTranscriptsTable)
      .where(eq(schema.agentRunTranscriptsTable.runId, params.runId))
      .limit(1);
    if (!transcript?.isComplete) return null;
    const sizes = await db
      .select({
        sequence: schema.agentRunTranscriptChunksTable.sequence,
        uncompressedBytes:
          schema.agentRunTranscriptChunksTable.uncompressedBytes,
      })
      .from(schema.agentRunTranscriptChunksTable)
      .where(eq(schema.agentRunTranscriptChunksTable.runId, params.runId))
      .orderBy(desc(schema.agentRunTranscriptChunksTable.sequence));
    let firstSequence = sizes.at(-1)?.sequence ?? 0;
    let bytes = 0;
    for (const size of sizes) {
      firstSequence = size.sequence;
      bytes += size.uncompressedBytes;
      if (bytes >= params.maxBytes) break;
    }
    const chunks = await db
      .select()
      .from(schema.agentRunTranscriptChunksTable)
      .where(
        and(
          eq(schema.agentRunTranscriptChunksTable.runId, params.runId),
          gte(schema.agentRunTranscriptChunksTable.sequence, firstSequence),
        ),
      )
      .orderBy(asc(schema.agentRunTranscriptChunksTable.sequence));
    return {
      transcript,
      chunks: chunks.map((chunk) => normalizeByteaField(chunk, "data")),
      firstSequence,
    };
  }

  /**
   * Where a recording's terminal size last changed at or before the end of
   * chunk `throughSequence`, from the sizes indexed when the chunks were
   * stored: the nearest indexed size, and the nearest chunk whose size was
   * never indexed (stored before sizes were), which may hold a later one.
   */
  static async findLastSizeMarkerIndex(params: {
    runId: string;
    throughSequence: number;
  }): Promise<{
    indexed: { sequence: number; marker: string } | null;
    unindexedSequence: number | null;
  }> {
    const table = schema.agentRunTranscriptChunksTable;
    const upTo = and(
      eq(table.runId, params.runId),
      lte(table.sequence, params.throughSequence),
    );
    const [[indexed], [unindexed]] = await Promise.all([
      db
        .select({ sequence: table.sequence, marker: table.lastSizeMarker })
        .from(table)
        .where(
          and(
            upTo,
            isNotNull(table.lastSizeMarker),
            ne(table.lastSizeMarker, ""),
          ),
        )
        .orderBy(desc(table.sequence))
        .limit(1),
      db
        .select({ sequence: table.sequence })
        .from(table)
        .where(and(upTo, isNull(table.lastSizeMarker)))
        .orderBy(desc(table.sequence))
        .limit(1),
    ]);
    return {
      indexed: indexed?.marker
        ? { sequence: indexed.sequence, marker: indexed.marker }
        : null,
      unindexedSequence: unindexed?.sequence ?? null,
    };
  }

  /** Stored recording sizes by run id, for the runs that have one. */
  static async findSizesByRunIds(
    runIds: string[],
  ): Promise<Map<string, number>> {
    if (runIds.length === 0) return new Map();
    const rows = await db
      .select({
        runId: schema.agentRunTranscriptsTable.runId,
        uncompressedBytes: schema.agentRunTranscriptsTable.uncompressedBytes,
      })
      .from(schema.agentRunTranscriptsTable)
      .where(inArray(schema.agentRunTranscriptsTable.runId, runIds));
    return new Map(rows.map((row) => [row.runId, row.uncompressedBytes]));
  }

  /** One stored chunk of a recording, or null. */
  static async findChunk(params: {
    runId: string;
    sequence: number;
  }): Promise<AgentRunTranscriptChunk | null> {
    const [chunk] = await db
      .select()
      .from(schema.agentRunTranscriptChunksTable)
      .where(
        and(
          eq(schema.agentRunTranscriptChunksTable.runId, params.runId),
          eq(schema.agentRunTranscriptChunksTable.sequence, params.sequence),
        ),
      )
      .limit(1);
    return chunk ? normalizeByteaField(chunk, "data") : null;
  }

  static async replaceReadable(
    params: {
      runId: string;
      provider: string;
      version: number;
      uncompressedBytes: number;
      chunks: InsertAgentRunReadableTranscriptChunk[];
    } | null,
  ): Promise<void> {
    if (!params) return;
    const compressedBytes = params.chunks.reduce(
      (total, chunk) => total + chunk.compressedBytes,
      0,
    );

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.agentRunReadableTranscriptsTable)
        .where(eq(schema.agentRunReadableTranscriptsTable.runId, params.runId));
      await tx.insert(schema.agentRunReadableTranscriptsTable).values({
        runId: params.runId,
        provider: params.provider,
        version: params.version,
        uncompressedBytes: params.uncompressedBytes,
        compressedBytes,
        chunkCount: params.chunks.length,
      });
      if (params.chunks.length > 0) {
        await tx
          .insert(schema.agentRunReadableTranscriptChunksTable)
          .values(params.chunks);
      }
    });
  }

  static async deleteReadable(runId: string): Promise<void> {
    await db
      .delete(schema.agentRunReadableTranscriptsTable)
      .where(eq(schema.agentRunReadableTranscriptsTable.runId, runId));
  }

  static async findReadableByRunId(runId: string): Promise<{
    transcript: AgentRunReadableTranscriptRecord;
    chunks: AgentRunReadableTranscriptChunk[];
  } | null> {
    const [transcript] = await db
      .select()
      .from(schema.agentRunReadableTranscriptsTable)
      .where(eq(schema.agentRunReadableTranscriptsTable.runId, runId))
      .limit(1);
    if (!transcript) return null;

    const chunks = await db
      .select()
      .from(schema.agentRunReadableTranscriptChunksTable)
      .where(eq(schema.agentRunReadableTranscriptChunksTable.runId, runId))
      .orderBy(asc(schema.agentRunReadableTranscriptChunksTable.sequence));

    return {
      transcript,
      chunks: chunks.map((chunk) => normalizeByteaField(chunk, "data")),
    };
  }
}
