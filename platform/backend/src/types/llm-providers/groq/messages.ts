import { z } from "zod";

const FunctionToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["function"]),
    function: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .describe(`https://console.groq.com/docs/tool-use`),
  })
  .describe(`https://console.groq.com/docs/tool-use`);

const CustomToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["custom"]),
    custom: z
      .object({
        input: z.string(),
        name: z.string(),
      })
      .describe(`Custom tool call`),
  })
  .describe(`Custom tool call`);

export const ToolCallSchema = z
  .union([FunctionToolCallSchema, CustomToolCallSchema])
  .describe(`https://console.groq.com/docs/tool-use`);

const ContentPartRefusalSchema = z
  .object({
    type: z.enum(["refusal"]),
    refusal: z.string(),
  })
  .describe(`Refusal content part`);

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe(`Text content part`);

const ContentPartImageSchema = z
  .object({
    type: z.enum(["image_url"]),
    image_url: z
      .object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .describe(`Image content part`),
  })
  .describe(`Image content part`);

const ContentPartSchema = z
  .union([ContentPartTextSchema, ContentPartImageSchema])
  .describe(`Content part`);

const SystemMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
  })
  .describe(`https://console.groq.com/docs/api-reference#chat-create`);

const UserMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
  })
  .describe(`https://console.groq.com/docs/api-reference#chat-create`);

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
    function_call: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .nullable()
      .optional(),
    name: z.string().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe(`https://console.groq.com/docs/api-reference#chat-create`);

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.string(),
    tool_call_id: z.string(),
  })
  .describe(`https://console.groq.com/docs/api-reference#chat-create`);

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
  ])
  .describe(`https://console.groq.com/docs/api-reference#chat-create`);
