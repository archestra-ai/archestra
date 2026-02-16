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
      .describe(`https://console.deepseek.com/docs/api-reference#chat-create`),
  })
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

export const ToolCallSchema = z
  .union([FunctionToolCallSchema])
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

const ContentPartImageSchema = z
  .object({
    type: z.enum(["image_url"]),
    image_url: z
      .object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .describe(`https://console.deepseek.com/docs/api-reference#chat-create`),
  })
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

const ContentPartSchema = z
  .union([ContentPartTextSchema, ContentPartImageSchema])
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

const SystemMessageParamSchema = z
  .object({
    role: z.enum(["system"]),
    content: z.string(),
    name: z.string().optional(),
  })
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

const UserMessageParamSchema = z
  .object({
    role: z.enum(["user"]),
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    name: z.string().optional(),
  })
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.string(),
    tool_call_id: z.string(),
  })
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
  ])
  .describe(`https://console.deepseek.com/docs/api-reference#chat-create`);
