import { z } from "zod";

// x.ai uses OpenAI-compatible message formats
// Reference: https://docs.x.ai/api/endpoints#chat-completions

const FunctionToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["function"]),
    function: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .describe("Function call details"),
  })
  .describe("Function tool call from x.ai API");

export const ToolCallSchema = z
  .union([FunctionToolCallSchema])
  .describe("Tool call from x.ai API response");

const ContentPartRefusalSchema = z
  .object({
    type: z.enum(["refusal"]),
    refusal: z.string(),
  })
  .describe("Content part indicating model refusal");

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
      .describe("Image URL configuration"),
  })
  .describe("Image content part");

const ContentPartSchema = z
  .union([ContentPartTextSchema, ContentPartImageSchema])
  .describe("Content part for x.ai messages");

const SystemMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
  })
  .describe("System message for x.ai API");

const UserMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
  })
  .describe("User message for x.ai API");

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z
      .union([
        z.string(),
        z.array(ContentPartTextSchema),
        z.array(ContentPartRefusalSchema),
      ])
      .nullable()
      .optional(),
    name: z.string().optional(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe("Assistant message for x.ai API");

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.union([
      z.string(),
      z.array(z.union([ContentPartTextSchema, ContentPartImageSchema])),
    ]),
    tool_call_id: z.string(),
  })
  .describe("Tool result message for x.ai API");

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
  ])
  .describe("Message parameter for x.ai chat completions API");
