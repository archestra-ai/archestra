import { z } from "zod";
import { MessageContentBlockSchema, MessageParamSchema } from "./messages";
import { ToolSchema } from "./tools";

const ToolChoiceAutoSchema = z.object({
  type: z.enum(["auto"]),
  disable_parallel_tool_use: z.boolean().optional(),
});

const ToolChoiceAnySchema = z.object({
  type: z.enum(["any"]),
  disable_parallel_tool_use: z.boolean().optional(),
});

const ToolChoiceToolSchema = z.object({
  type: z.enum(["tool"]),
  name: z.string(),
  disable_parallel_tool_use: z.boolean().optional(),
});

const ToolChoiceNoneSchema = z.object({
  type: z.enum(["none"]),
});

const ToolChoiceSchema = z.union([
  ToolChoiceAutoSchema,
  ToolChoiceAnySchema,
  ToolChoiceToolSchema,
  ToolChoiceNoneSchema,
]);

export const MessagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageParamSchema),
  max_tokens: z.number(),
  container: z.string().nullable().optional(),
  context_management: z.object().nullable().optional(),
  mcp_servers: z.array(z.any()).optional(),
  metadata: z
    .object({
      user_id: z.string().nullable(),
    })
    .optional(),
  service_tier: z.any().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  system: z
    .union([
      z.string(),
      z.object({
        type: z.enum(["text"]),
        text: z.string(),
        cache_control: z.any().nullable().optional(),
        citations: z.array(z.any()).nullable().optional(),
      }),
      z.array(
        z.object({
          type: z.enum(["text"]),
          text: z.string(),
          cache_control: z.any().nullable().optional(),
          citations: z.array(z.any()).nullable().optional(),
        }),
      ),
    ])
    .optional(),
  temperature: z.number().optional(),
  tool_choice: ToolChoiceSchema.optional(),
  tools: z.array(ToolSchema).optional(),
  top_k: z.number().optional(),
  top_p: z.number().optional(),
});

export const UsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

export const MessagesResponseSchema = z.object({
  id: z.string(),
  content: z.array(MessageContentBlockSchema),
  model: z.string(),
  role: z.enum(["assistant"]),
  stop_reason: z.any().nullable(),
  stop_sequence: z.string().nullable(),
  type: z.enum(["message"]),
  usage: UsageSchema,
});

export const MessagesHeadersSchema = z
  .object({
    "user-agent": z
      .string()
      .optional()
      .describe("The user agent of the client"),
    "anthropic-version": z.string(),
    "anthropic-beta": z
      .string()
      .optional()
      .describe("Beta features to enable (comma-separated)"),
    "x-api-key": z.string().optional(),
    authorization: z
      .string()
      .optional()
      .describe("Authorization header (Bearer token for OAuth)"),
  })
  .describe(`https://docs.claude.com/en/api/messages#parameter-anthropic-beta`);
