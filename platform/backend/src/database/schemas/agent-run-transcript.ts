import {
  boolean,
  customType,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import agentRunsTable from "./agent-run";

export const agentRunTranscriptsTable = pgTable("agent_run_transcripts", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => agentRunsTable.id, { onDelete: "cascade" }),
  uncompressedBytes: integer("uncompressed_bytes").notNull(),
  compressedBytes: integer("compressed_bytes").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  isComplete: boolean("is_complete").notNull(),
});

export const agentRunTranscriptChunksTable = pgTable(
  "agent_run_transcript_chunks",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRunTranscriptsTable.runId, {
        onDelete: "cascade",
      }),
    sequence: integer("sequence").notNull(),
    uncompressedBytes: integer("uncompressed_bytes").notNull(),
    compressedBytes: integer("compressed_bytes").notNull(),
    data: bytea("data").notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_run_transcript_chunks_pk",
      columns: [table.runId, table.sequence],
    }),
  ],
);

export const agentRunReadableTranscriptsTable = pgTable(
  "agent_run_readable_transcripts",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => agentRunsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    version: integer("version").notNull(),
    uncompressedBytes: integer("uncompressed_bytes").notNull(),
    compressedBytes: integer("compressed_bytes").notNull(),
    chunkCount: integer("chunk_count").notNull(),
  },
);

export const agentRunReadableTranscriptChunksTable = pgTable(
  "agent_run_readable_transcript_chunks",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRunReadableTranscriptsTable.runId, {
        onDelete: "cascade",
      }),
    sequence: integer("sequence").notNull(),
    uncompressedBytes: integer("uncompressed_bytes").notNull(),
    compressedBytes: integer("compressed_bytes").notNull(),
    data: bytea("data").notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_run_readable_transcript_chunks_pk",
      columns: [table.runId, table.sequence],
    }),
  ],
);

// ===================== internals =====================

function bytea(name: string) {
  return customType<{ data: Buffer; driverParam: Buffer }>({
    dataType() {
      return "bytea";
    },
  })(name);
}
