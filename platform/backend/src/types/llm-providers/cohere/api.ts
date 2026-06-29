import { z } from "zod";
import {
  CohereMessageContentBlockSchema,
  CohereMessageParamSchema,
  CohereToolCallSchema,
} from "./messages";
import { CohereToolSchema } from "./tools";

/**
 * Cohere v2 Chat API request schema
 * API Reference: https://docs.cohere.com/reference/chat
 */
export const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(CohereMessageParamSchema),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  tools: z.array(CohereToolSchema).optional(),
  tool_choice: z.enum(["REQUIRED", "NONE"]).optional(),
  safety_mode: z.enum(["CONTEXTUAL", "STRICT", "OFF"]).optional(),
  response_format: z
    .object({
      type: z.enum(["json_object", "text"]),
      json_schema: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  k: z.number().optional(),
  p: z.number().optional(),
  seed: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  logprobs: z.boolean().optional(),
});

export const UsageSchema = z.object({
  billed_units: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
  tokens: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export const ChatResponseSchema = z.object({
  id: z.string(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(CohereMessageContentBlockSchema).optional(),
    tool_calls: z.array(CohereToolCallSchema).optional(),
  }),
  finish_reason: z.enum([
    "COMPLETE",
    "MAX_TOKENS",
    "STOP_SEQUENCE",
    "TOOL_CALL",
    "ERROR",
  ]),
  usage: UsageSchema.optional(),
});

export const ChatHeadersSchema = z
  .object({
    "user-agent": z
      .string()
      .optional()
      .describe("The user agent of the client"),
    authorization: z.string().optional().describe("Bearer token for API auth"),
  })
  .describe("Cohere API request headers");
