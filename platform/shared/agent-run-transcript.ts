import { z } from "zod";

const AgentRunReadableMessageSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  timestamp: z.string().optional(),
  id: z.string().optional(),
});

const AgentRunReadableToolCallSchema = z.object({
  type: z.literal("tool_call"),
  name: z.string(),
  input: z.string().optional(),
  toolCallId: z.string().optional(),
  timestamp: z.string().optional(),
  id: z.string().optional(),
});

const AgentRunReadableToolResultSchema = z.object({
  type: z.literal("tool_result"),
  text: z.string(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  timestamp: z.string().optional(),
  id: z.string().optional(),
});

export const AgentRunReadableTranscriptSchema = z.object({
  version: z.literal(1),
  provider: z.string().min(1),
  session: z
    .object({
      state: z.enum([
        "starting",
        "working",
        "idle",
        "input_required",
        "failed",
        "stopped",
      ]),
      requests: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string().optional(),
          options: z.array(z.object({ id: z.string(), label: z.string() })),
          questions: z
            .array(
              z.object({
                id: z.string(),
                text: z.string(),
                options: z.array(z.string()).optional(),
              }),
            )
            .optional(),
        }),
      ),
      error: z.string().optional(),
    })
    .optional(),
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

export const AgentRunControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    text: z.string().trim().min(1).max(100_000),
  }),
  z.object({ type: z.literal("interrupt") }),
  z.object({
    type: z.literal("respond"),
    requestId: z.string(),
    optionId: z.string().optional(),
    answers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type AgentRunControl = z.infer<typeof AgentRunControlSchema>;
