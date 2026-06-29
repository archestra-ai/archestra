import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().optional(),
      })
      .optional(),
  })
  .describe(
    `https://platform.minimax.io/docs/api-reference/text-openai-api#usage`,
  );

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
]);

/**
 * Reasoning detail object in MiniMax responses
 * Contains the model's thinking process when reasoning_split=True
 */
const ReasoningDetailSchema = z.object({
  text: z.string(),
});

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable().optional(),
    message: z
      .object({
        content: z.string().nullable(),
        role: z.enum(["assistant"]),
        /**
         * Array of reasoning details (thinking content)
         * Only present when reasoning_split=True is used in request
         */
        reasoning_details: z.array(ReasoningDetailSchema).optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
      })
      .describe(
        `https://platform.minimax.io/docs/api-reference/text-openai-api#response`,
      ),
  })
  .describe(
    `https://platform.minimax.io/docs/api-reference/text-openai-api#response`,
  );

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageParamSchema),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceOptionSchema.optional(),
    stream: z.boolean().optional(),
    /**
     * Temperature range: (0.0, 1.0] (exclusive of 0.0)
     * Recommended value: 1.0
     */
    temperature: z.number().gt(0).max(1).nullable().optional(),
    top_p: z.number().min(0).max(1).nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    /**
     * Number of completions to generate
     * MiniMax only supports n=1
     */
    n: z.literal(1).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    response_format: z
      .object({
        type: z.enum(["text", "json_object"]),
      })
      .optional(),
    user: z.string().optional(),
    /**
     * Extra parameters specific to MiniMax
     * reasoning_split: Set to true to separate thinking content into reasoning_details field
     */
    extra_body: z
      .object({
        reasoning_split: z.boolean().optional(),
      })
      .optional(),
  })
  .describe(
    `https://platform.minimax.io/docs/api-reference/text-openai-api#request-body`,
  );

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe(
    `https://platform.minimax.io/docs/api-reference/text-openai-api#response`,
  );

export const ChatCompletionHeadersSchema = z.object({
  authorization: z.string().optional(),
});
