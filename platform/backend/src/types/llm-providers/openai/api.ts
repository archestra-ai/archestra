import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    completion_tokens_details: z
      .any()
      .optional()
      .describe(
        `https://github.com/openai/openai-node/blob/master/src/resources/completions.ts#L144`,
      ),
    prompt_tokens_details: z
      .any()
      .optional()
      .describe(
        `https://github.com/openai/openai-node/blob/master/src/resources/completions.ts#L173`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/master/src/resources/completions.ts#L113`,
  );

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
]);

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        content: z.string().nullable(),
        refusal: z.string().nullable().optional(),
        role: z.enum(["assistant"]),
        annotations: z.array(z.any()).optional(),
        audio: z.any().nullable().optional(),
        function_call: z
          .object({
            arguments: z.string(),
            name: z.string(),
          })
          .nullable()
          .optional()
          .describe(
            `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L431`,
          ),
        tool_calls: z.array(ToolCallSchema).nullable().optional(),
      })
      .describe(
        `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1000`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L311`,
  );

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageParamSchema),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceOptionSchema.optional(),
    temperature: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    stream: z.boolean().nullable().optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1487`,
  );

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    server_tier: z.string().optional(),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L248`,
  );

// ===== Responses API =====

const ResponsesInputItemSchema = z
  .object({
    type: z.string(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses/methods/create",
  );

const ResponsesFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string(),
    description: z.string().nullable().optional(),
    parameters: z.record(z.string(), z.unknown()).nullable().optional(),
    strict: z.boolean().nullable().optional(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses/methods/create",
  );

const ResponsesToolSchema = z
  .object({
    type: z.string(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses/methods/create",
  );

export const ResponsesRequestSchema = z
  .object({
    model: z.string(),
    input: z.union([z.string(), z.array(ResponsesInputItemSchema)]).optional(),
    instructions: z.string().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
    previous_response_id: z.string().nullable().optional(),
    stream: z.boolean().nullable().optional(),
    temperature: z.number().nullable().optional(),
    text: z.unknown().optional(),
    tool_choice: z.unknown().optional(),
    tools: z
      .array(z.union([ResponsesFunctionToolSchema, ResponsesToolSchema]))
      .optional(),
    top_p: z.number().nullable().optional(),
    user: z.string().optional(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses/methods/create",
  );

export const ResponsesUsageSchema = z
  .object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses#(resource)%20responses%20%3E%20(model)%20response_usage%20%3E%20(schema)",
  );

const ResponsesOutputTextSchema = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses#(resource)%20responses%20%3E%20(model)%20response_output_text%20%3E%20(schema)",
  );

const ResponsesOutputRefusalSchema = z
  .object({
    type: z.literal("refusal"),
    refusal: z.string(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses#(resource)%20responses%20%3E%20(model)%20response_output_refusal%20%3E%20(schema)",
  );

const ResponsesOutputMessageSchema = z
  .object({
    id: z.string(),
    type: z.literal("message"),
    role: z.literal("assistant"),
    status: z.string(),
    content: z.array(
      z.union([ResponsesOutputTextSchema, ResponsesOutputRefusalSchema]),
    ),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses#(resource)%20responses%20%3E%20(model)%20response_output_message%20%3E%20(schema)",
  );

const ResponsesFunctionCallSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    status: z.string().optional(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses#(resource)%20responses%20%3E%20(model)%20response%20%3E%20(schema)",
  );

export const ResponsesResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal("response"),
    created_at: z.number(),
    model: z.string(),
    output: z.array(
      z.union([
        ResponsesOutputMessageSchema,
        ResponsesFunctionCallSchema,
        z.object({ type: z.string() }).passthrough(),
      ]),
    ),
    status: z.string(),
    usage: ResponsesUsageSchema.optional(),
  })
  .passthrough()
  .describe(
    "https://developers.openai.com/api/reference/resources/responses#(resource)%20responses%20%3E%20(model)%20response%20%3E%20(schema)",
  );

// ===== Embeddings API =====

export const EmbeddingUsageSchema = z.object({
  prompt_tokens: z.number(),
  total_tokens: z.number(),
});

export const EmbeddingRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  dimensions: z.number().optional(),
  encoding_format: z.enum(["float", "base64"]).optional(),
});

export const EmbeddingResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      object: z.literal("embedding"),
      embedding: z.array(z.number()),
      index: z.number(),
    }),
  ),
  model: z.string(),
  usage: EmbeddingUsageSchema,
});

// ===== Chat Completions Headers =====

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for OpenAI")
    .transform((authorization) => authorization.replace("Bearer ", "")),
});
