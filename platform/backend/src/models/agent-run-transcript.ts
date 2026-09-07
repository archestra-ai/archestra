import { asc, eq } from "drizzle-orm";
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
