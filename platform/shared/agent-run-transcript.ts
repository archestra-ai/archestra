import { z } from "zod";

const AgentRunReadableMessageSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  timestamp: z.string().optional(),
});

const AgentRunReadableToolCallSchema = z.object({
  type: z.literal("tool_call"),
  name: z.string(),
  input: z.string().optional(),
  toolCallId: z.string().optional(),
  timestamp: z.string().optional(),
});

const AgentRunReadableToolResultSchema = z.object({
  type: z.literal("tool_result"),
  text: z.string(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  timestamp: z.string().optional(),
});

export const AgentRunReadableTranscriptSchema = z.object({
  version: z.literal(1),
  provider: z.string().min(1),
  entries: z.array(
    z.discriminatedUnion("type", [
      AgentRunReadableMessageSchema,
      AgentRunReadableToolCallSchema,
      AgentRunReadableToolResultSchema,
    ]),
  ),
});

export type AgentRunReadableTranscript = z.infer<
  typeof AgentRunReadableTranscriptSchema
>;
export type AgentRunReadableTranscriptEntry =
  AgentRunReadableTranscript["entries"][number];
