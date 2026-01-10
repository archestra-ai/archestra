import { z } from "zod";

/**
 * Cerebras uses OpenAI-compatible message format
 * https://inference-docs.cerebras.ai/api-reference/chat-completions
 */

const FunctionToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["function"]),
    function: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .describe("Function tool call details"),
  })
  .describe("Function tool call in OpenAI-compatible format");

export const ToolCallSchema = FunctionToolCallSchema.describe(
  "Tool call in Cerebras response (OpenAI-compatible format)",
);

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe("Text content part");

const ContentPartImageSchema = z
  .object({
    type: z.enum(["image_url"]),
    image_url: z
      .object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .describe("Image URL details"),
  })
  .describe("Image content part");

const ContentPartSchema = z
  .union([ContentPartTextSchema, ContentPartImageSchema])
  .describe("Content part in a message");

const SystemMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
  })
  .describe("System message");

const UserMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
  })
  .describe("User message");

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe("Assistant message");

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.union([
      z.string(),
      z.array(z.union([ContentPartTextSchema, ContentPartImageSchema])),
    ]),
    tool_call_id: z.string(),
  })
  .describe("Tool result message");

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
  ])
  .describe("Message parameter for Cerebras chat completions API");
