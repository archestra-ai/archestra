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
      .describe(`https://api-docs.deepseek.com/api/create-chat-completion`),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

export const ToolCallSchema = z
  .union([FunctionToolCallSchema])
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const ContentPartImageSchema = z
  .object({
    type: z.enum(["image_url"]),
    image_url: z
      .object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .describe(`https://api-docs.deepseek.com/api/create-chat-completion`),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const ContentPartSchema = z
  .union([ContentPartTextSchema, ContentPartImageSchema])
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const SystemMessageParamSchema = z
  .object({
    role: z.enum(["system"]),
    content: z.string(),
    name: z.string().optional(),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const UserMessageParamSchema = z
  .object({
    role: z.enum(["user"]),
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    name: z.string().optional(),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    prefix: z.boolean().optional(),
    reasoning_content: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.string(),
    tool_call_id: z.string(),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
  ])
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);
