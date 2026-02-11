/**
 * Groq Type Definitions
 *
 * Groq exposes an OpenAI-compatible API, so these types are based on OpenAI types.
 * See: https://console.groq.com/docs/api-reference
 */
import { z } from "zod";

// =============================================================================
// API SCHEMAS (for request/response validation)
// =============================================================================

// ---------------------------------------------------------------------------
// Common Schemas
// ---------------------------------------------------------------------------

const MessageContentPartTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const MessageContentPartImageSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});

const MessageContentPartSchema = z.union([
  MessageContentPartTextSchema,
  MessageContentPartImageSchema,
]);

const MessageContentSchema = z.union([
  z.string(),
  z.array(MessageContentPartSchema),
]);

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const FunctionToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const CustomToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("custom"),
  custom: z.object({
    name: z.string(),
    input: z.string(),
  }),
});

const ToolCallSchema = z.union([FunctionToolCallSchema, CustomToolCallSchema]);

const FunctionDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});

const ToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: FunctionDefinitionSchema,
});

// ---------------------------------------------------------------------------
// Message Schemas
// ---------------------------------------------------------------------------

const SystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
  name: z.string().optional(),
});

const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: MessageContentSchema,
  name: z.string().optional(),
});

const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().nullish(),
  name: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  refusal: z.string().nullish(),
});

const ToolMessageSchema = z.object({
  role: z.literal("tool"),
  content: z.union([z.string(), z.array(z.unknown())]),
  tool_call_id: z.string(),
});

const MessageSchema = z.union([
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);

// ---------------------------------------------------------------------------
// Request Schema
// ---------------------------------------------------------------------------

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().min(1).optional(),
  stream: z.boolean().optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.number()).optional(),
  user: z.string().optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  tool_choice: z
    .union([
      z.literal("none"),
      z.literal("auto"),
      z.literal("required"),
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
        }),
      }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object"]),
    })
    .optional(),
  seed: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Response Schema
// ---------------------------------------------------------------------------

const UsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  prompt_time: z.number().optional(),
  completion_time: z.number().optional(),
  queue_time: z.number().optional(),
  total_time: z.number().optional(),
});

const ChoiceMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().nullable(),
  refusal: z.string().nullable(),
  tool_calls: z.array(FunctionToolCallSchema).optional(),
});

const LogprobsSchema = z
  .object({
    content: z.array(z.unknown()).nullable(),
  })
  .nullable();

const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
]);

const ChoiceSchema = z.object({
  index: z.number(),
  message: ChoiceMessageSchema,
  logprobs: LogprobsSchema,
  finish_reason: FinishReasonSchema,
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChoiceSchema),
  usage: UsageSchema.optional(),
  system_fingerprint: z.string().optional(),
  x_groq: z
    .object({
      id: z.string().optional(),
      usage: z
        .object({
          queue_time: z.number().optional(),
          prompt_tokens: z.number().optional(),
          prompt_time: z.number().optional(),
          completion_tokens: z.number().optional(),
          completion_time: z.number().optional(),
          total_tokens: z.number().optional(),
          total_time: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Streaming Schema
// ---------------------------------------------------------------------------

const DeltaSchema = z.object({
  role: z.literal("assistant").optional(),
  content: z.string().nullish(),
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
      }),
    )
    .optional(),
});

const StreamChoiceSchema = z.object({
  index: z.number(),
  delta: DeltaSchema,
  finish_reason: FinishReasonSchema.nullable(),
  logprobs: LogprobsSchema.optional(),
});

export const ChatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number(),
  model: z.string(),
  choices: z.array(StreamChoiceSchema),
  usage: UsageSchema.optional(),
  system_fingerprint: z.string().optional(),
  x_groq: z
    .object({
      id: z.string().optional(),
      usage: z
        .object({
          queue_time: z.number().optional(),
          prompt_tokens: z.number().optional(),
          prompt_time: z.number().optional(),
          completion_tokens: z.number().optional(),
          completion_time: z.number().optional(),
          total_tokens: z.number().optional(),
          total_time: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Headers Schema
// ---------------------------------------------------------------------------

export const ChatCompletionsHeadersSchema = z.object({
  authorization: z.string().optional(),
  "content-type": z.string().optional(),
  "x-request-id": z.string().optional(),
});

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type ChatCompletionsRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionsResponse = z.infer<typeof ChatCompletionResponseSchema>;
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;
export type ChatCompletionsHeaders = z.infer<typeof ChatCompletionsHeadersSchema>;
export type FinishReason = z.infer<typeof FinishReasonSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type Usage = z.infer<typeof UsageSchema>;

// =============================================================================
// NAMESPACE EXPORTS (for compatibility with existing code)
// =============================================================================

export namespace Groq {
  export namespace API {
    export const ChatCompletionRequestSchema = ChatCompletionRequestSchema;
    export const ChatCompletionResponseSchema = ChatCompletionResponseSchema;
    export const ChatCompletionChunkSchema = ChatCompletionChunkSchema;
    export const ChatCompletionsHeadersSchema = ChatCompletionsHeadersSchema;
  }

  export namespace Types {
    export type ChatCompletionsRequest = ChatCompletionsRequest;
    export type ChatCompletionsResponse = ChatCompletionsResponse;
    export type ChatCompletionChunk = ChatCompletionChunk;
    export type ChatCompletionsHeaders = ChatCompletionsHeaders;
    export type FinishReason = FinishReason;
    export type Message = Message;
    export type ToolCall = ToolCall;
    export type ToolDefinition = ToolDefinition;
    export type Usage = Usage;
  }
}
