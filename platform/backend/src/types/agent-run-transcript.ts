import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAgentRunTranscriptSchema = createSelectSchema(
  schema.agentRunTranscriptsTable,
);
export const InsertAgentRunTranscriptSchema = createInsertSchema(
  schema.agentRunTranscriptsTable,
);
export const SelectAgentRunTranscriptChunkSchema = createSelectSchema(
  schema.agentRunTranscriptChunksTable,
);
export const InsertAgentRunTranscriptChunkSchema = createInsertSchema(
  schema.agentRunTranscriptChunksTable,
);
export const SelectAgentRunReadableTranscriptSchema = createSelectSchema(
  schema.agentRunReadableTranscriptsTable,
);
export const InsertAgentRunReadableTranscriptSchema = createInsertSchema(
  schema.agentRunReadableTranscriptsTable,
);
export const SelectAgentRunReadableTranscriptChunkSchema = createSelectSchema(
  schema.agentRunReadableTranscriptChunksTable,
);
export const InsertAgentRunReadableTranscriptChunkSchema = createInsertSchema(
  schema.agentRunReadableTranscriptChunksTable,
);

export type AgentRunTranscript = z.infer<typeof SelectAgentRunTranscriptSchema>;
export type InsertAgentRunTranscript = z.infer<
  typeof InsertAgentRunTranscriptSchema
>;
export type AgentRunTranscriptChunk = z.infer<
  typeof SelectAgentRunTranscriptChunkSchema
>;
export type InsertAgentRunTranscriptChunk = z.infer<
  typeof InsertAgentRunTranscriptChunkSchema
>;
export type AgentRunReadableTranscriptRecord = z.infer<
  typeof SelectAgentRunReadableTranscriptSchema
>;
export type InsertAgentRunReadableTranscript = z.infer<
  typeof InsertAgentRunReadableTranscriptSchema
>;
export type AgentRunReadableTranscriptChunk = z.infer<
  typeof SelectAgentRunReadableTranscriptChunkSchema
>;
export type InsertAgentRunReadableTranscriptChunk = z.infer<
  typeof InsertAgentRunReadableTranscriptChunkSchema
>;
