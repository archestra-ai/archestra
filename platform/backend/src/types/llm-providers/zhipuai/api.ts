import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number(),
      })
      .optional()
      .describe(`https://docs.z.ai/api-reference/llm/chat-completion#response`),
  })
  .describe(`https://docs.z.ai/api-reference/llm/chat-completion#response`);

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "sensitive",
  "network_error",
]);

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        content: z.string().nullable(),
        role: z.enum(["assistant"]),
        reasoning_content: z.string().optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
        function_call: z
          .object({
            arguments: z.string(),
            name: z.string(),
          })
          .nullable()
          .optional(),
      })
      .describe(`https://docs.z.ai/api-reference/llm/chat-completion#response`),
  })
  .describe(`https://docs.z.ai/api-reference/llm/chat-completion#response`);

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageParamSchema),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceOptionSchema.optional(),
    request_id: z.string().optional(),
    do_sample: z.boolean().optional(),
    stream: z.boolean().optional(),
    thinking: z
      .object({
        type: z.enum(["enabled", "disabled"]),
        clear_thinking: z.boolean().optional(),
      })
      .optional(),
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    tool_stream: z.boolean().optional(),
    stop: z.array(z.string()).optional(),
    response_format: z
      .object({
        type: z.enum(["text", "json_object"]),
      })
      .optional(),
    user_id: z.string().optional(),
  })
  .describe(`https://docs.z.ai/api-reference/llm/chat-completion#body`);

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    request_id: z.string().optional(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
    web_search: z
      .array(
        z.object({
          title: z.string(),
          content: z.string(),
          link: z.string(),
          media: z.string(),
          icon: z.string(),
          refer: z.string(),
          publish_date: z.string(),
        }),
      )
      .optional()
      .describe(`https://docs.z.ai/api-reference/llm/chat-completion#response`),
  })
  .describe(`https://docs.z.ai/api-reference/llm/chat-completion#response`);

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for Zhipu AI")
    .transform((authorization) => authorization.replace("Bearer ", "")),
  "accept-language": z.string().optional(),
});
