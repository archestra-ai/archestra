import { z } from "zod";

/**
 * Mistral AI message types for chat completions API.
 * Mistral uses an OpenAI-compatible API format.
 * @see https://docs.mistral.ai/api/#operation/createChatCompletion
 */

const FunctionToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["function"]),
    function: z.object({
      arguments: z.string(),
      name: z.string(),
    }),
  })
  .describe("A tool call requesting execution of a function");

export const ToolCallSchema = FunctionToolCallSchema.describe(
  "A tool call from the model",
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
    image_url: z.object({
      url: z.string(),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  })
  .describe("Image URL content part");

const ContentPartSchema = z
  .union([ContentPartTextSchema, ContentPartImageSchema])
  .describe("Content part in a message");

const SystemMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
  })
  .describe("System message setting context for the conversation");

const UserMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
  })
  .describe("User message in the conversation");

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe("Assistant message in the conversation");

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.string(),
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
  .describe("A message in the Mistral chat completions API");
