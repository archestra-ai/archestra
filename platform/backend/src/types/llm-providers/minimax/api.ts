/**
 * MiniMax API types
 * https://api.minimax.chat/document/guides/llm-text/chat-pro/v2
 */
import { z } from "zod";

// Chat Completions Headers
export const ChatCompletionsHeadersSchema = z.object({
  Authorization: z.string().describe("Bearer API Key"),
  "Content-Type": z.literal("application/json"),
});
export type ChatCompletionsHeaders = z.infer<typeof ChatCompletionsHeadersSchema>;

// Chat Completion Request
export const ChatCompletionRequestSchema = z.object({
  model: z.string().describe("Model ID (e.g., glm-4, glm-4-plus)"),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string(),
        name: z.string().optional(),
      })
    )
    .describe("Messages array"),
  temperature: z.number().min(0).max(2).optional().describe("Temperature"),
  max_tokens: z.number().optional().describe("Max output tokens"),
  top_p: z.number().min(0).max(1).optional().describe("Top p sampling"),
  stream: z.boolean().optional().describe("Stream response"),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.any()).optional(),
        }),
      })
    )
    .optional()
    .describe("Function tools"),
  tool_choice: z.string().optional().describe("Tool choice"),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// Finish Reason
export const FinishReasonSchema = z.enum([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "null",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

// Usage
export const ChatCompletionUsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});
export type Usage = z.infer<typeof ChatCompletionUsageSchema>;

// Chat Completion Response
export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.literal("function"),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            })
          )
          .optional(),
      }),
      finish_reason: FinishReasonSchema,
    })
  ),
  usage: ChatCompletionUsageSchema,
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

// Stream Chunk
export const ChatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      delta: z.object({
        role: z.literal("assistant").optional(),
        content: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              index: z.number(),
              id: z.string().optional(),
              type: z.literal("function").optional(),
              function: z
                .object({
                  name: z.string().optional(),
                  arguments: z.string().optional(),
                })
                .optional(),
            })
          )
          .optional(),
      }),
      finish_reason: FinishReasonSchema.nullable(),
    })
  ),
});
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;