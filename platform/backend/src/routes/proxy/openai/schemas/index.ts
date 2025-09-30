/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the openai ts sdk doesn't expose zod schemas for all of this..
 */
import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const OpenAiApiKeySchema = z
  .string()
  .describe("Bearer token for OpenAI")
  .transform((authorization) => authorization.replace("Bearer ", ""));

const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    completion_tokens_details: z
      .object()
      .describe(
        `https://github.com/openai/openai-node/blob/master/src/resources/completions.ts#L144`,
      ),
    prompt_tokens_details: z
      .object()
      .describe(
        `https://github.com/openai/openai-node/blob/master/src/resources/completions.ts#L173`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/master/src/resources/completions.ts#L113`,
  );

const ChoiceSchema = z
  .object({
    finish_reason: z.enum([
      "stop",
      "length",
      "tool_calls",
      "content_filter",
      "function_call",
    ]),
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        content: z.string().nullable(),
        refusal: z.string().nullable(),
        role: z.literal("assistant"),
        annotations: z.array(z.any()).optional(),
        audio: z.any().nullable(),
        function_call: z
          .object({
            arguments: z.string(),
            name: z.string(),
          })
          .nullable()
          .describe(
            `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L431`,
          ),
        tool_calls: z.array(ToolCallSchema).optional(),
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
    object: z.literal("chat.completion"),
    server_tier: z.string().optional(),
    system_fingerprint: z.string().optional(),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L248`,
  );

/**
 * https://github.com/openai/openai-node/blob/v6.0.0/src/resources/models.ts#L38-L61
 */
export const ModelsResponseSchema = z.object({
  id: z
    .string()
    .describe(
      "The model identifier, which can be referenced in the API endpoints",
    ),
  created: z
    .number()
    .describe("The Unix timestamp (in seconds) when the model was created."),
  object: z
    .literal("model")
    .describe("The object type, which is always 'model'"),
  owned_by: z.string().describe("The organization that owns the model"),
});
