import { z } from "zod";
import { MessageParamSchema, MessageContentBlockSchema } from "./messages";
import { ToolSchema, ToolCallSchema } from "./tools";

/**
 * Cohere V2 Chat API Request Schema
 * @see https://docs.cohere.com/reference/chat
 */

const ToolChoiceSchema = z.enum(["auto", "any", "none", "required"]);

const CitationModeSchema = z.enum(["accurate", "fast", "off"]).optional();

export const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageParamSchema),
  stream: z.boolean().optional(),
  tools: z.array(ToolSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  max_input_tokens: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  k: z.number().optional(),
  p: z.number().optional(),
  seed: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  safety_mode: z.enum(["strict", "contextual", "none"]).optional(),
  citation_options: z.object({
    mode: CitationModeSchema,
  }).optional(),
});

/**
 * Usage Schema for token counts
 */
export const UsageSchema = z.object({
  billed_units: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).optional(),
  tokens: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).optional(),
});

/**
 * Cohere V2 Chat API Response Schema
 */
export const ChatResponseSchema = z.object({
  id: z.string(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(MessageContentBlockSchema).optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
    tool_plan: z.string().optional(),
  }),
  finish_reason: z.enum([
    "COMPLETE",
    "STOP_SEQUENCE",
    "MAX_TOKENS",
    "TOOL_CALL",
    "ERROR",
  ]),
  usage: UsageSchema.optional(),
});

/**
 * Headers schema for Cohere API
 */
export const ChatHeadersSchema = z
  .object({
    "user-agent": z.string().optional(),
    authorization: z.string().optional(),
    "x-client-name": z.string().optional(),
  })
  .describe("https://docs.cohere.com/reference/chat");
