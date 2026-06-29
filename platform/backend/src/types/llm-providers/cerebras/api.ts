/**
 * Cerebras API schemas
 *
 * Cerebras uses an OpenAI-compatible API with some differences:
 * - content field is optional in responses (can be omitted when tool_calls present)
 *
 * @see https://inference-docs.cerebras.ai/
 * @see https://github.com/Cerebras/cerebras-cloud-sdk-node
 */
import { z } from "zod";

import { ToolCallSchema } from "./messages";

// Re-export schemas that are identical to OpenAI
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
} from "../openai/api";

import { ChatCompletionUsageSchema, FinishReasonSchema } from "../openai/api";

/**
 * Cerebras-specific Choice schema
 *
 * Differs from OpenAI: content is optional (can be omitted when tool_calls present)
 * @see https://github.com/Cerebras/cerebras-cloud-sdk-node/blob/main/src/resources/chat/completions.ts
 */
const CerebrasChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        // Cerebras: content is optional when tool_calls are present
        content: z.string().nullable().optional(),
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
          .optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
      })
      .describe(
        `https://github.com/Cerebras/cerebras-cloud-sdk-node/blob/main/src/resources/chat/completions.ts`,
      ),
  })
  .describe(
    `https://github.com/Cerebras/cerebras-cloud-sdk-node/blob/main/src/resources/chat/completions.ts`,
  );

/**
 * Cerebras-specific ChatCompletionResponse schema
 */
export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(CerebrasChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    server_tier: z.string().optional(),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe(
    `https://github.com/Cerebras/cerebras-cloud-sdk-node/blob/main/src/resources/chat/completions.ts`,
  );
