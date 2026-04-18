/**
 * Azure AI Foundry API schemas
 *
 * Azure AI Foundry provides an OpenAI-compatible API at your deployment endpoint.
 * Full tool calling support, streaming, and standard OpenAI message format.
 *
 * @see https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-reference
 */

import { z } from "zod";
import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();

const ResponsesInputItemSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const ResponsesFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string(),
    description: z.string().nullable().optional(),
    parameters: z.record(z.string(), z.unknown()).nullable().optional(),
    strict: z.boolean().nullable().optional(),
  })
  .passthrough();

const ResponsesToolSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

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
  .passthrough();

export const ResponsesUsageSchema = z
  .object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
  })
  .passthrough();

const ResponsesOutputTextSchema = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
  })
  .passthrough();

const ResponsesOutputRefusalSchema = z
  .object({
    type: z.literal("refusal"),
    refusal: z.string(),
  })
  .passthrough();

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
  .passthrough();

const ResponsesFunctionCallSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    status: z.string().optional(),
  })
  .passthrough();

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
  .passthrough();
