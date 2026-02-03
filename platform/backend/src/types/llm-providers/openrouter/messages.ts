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
      .describe(`https://openrouter.ai/docs/api-reference/chat-completion`),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

export const ToolCallSchema = z
  .union([FunctionToolCallSchema])
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const ContentPartImageSchema = z
  .object({
    type: z.enum(["image_url"]),
    image_url: z
      .object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .describe(`https://openrouter.ai/docs/api-reference/chat-completion`),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const ContentPartSchema = z
  .union([ContentPartTextSchema, ContentPartImageSchema])
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const SystemMessageParamSchema = z
  .object({
    role: z.enum(["system"]),
    content: z.string(),
    name: z.string().optional(),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const UserMessageParamSchema = z
  .object({
    role: z.enum(["user"]),
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    name: z.string().optional(),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
    function_call: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .optional(),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.string(),
    tool_call_id: z.string(),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

const FunctionMessageParamSchema = z
  .object({
    role: z.enum(["function"]),
    content: z.string(),
    name: z.string(),
  })
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
    FunctionMessageParamSchema,
  ])
  .describe(`https://openrouter.ai/docs/api-reference/chat-completion`);
