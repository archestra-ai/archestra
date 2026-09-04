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
