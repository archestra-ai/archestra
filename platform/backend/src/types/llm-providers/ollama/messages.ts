/**
 * Ollama Message Types
 *
 * Ollama uses OpenAI-compatible message format.
 * See: https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
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
      .describe("Function call details"),
  })
  .describe("A function tool call in the message");

const CustomToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["custom"]),
    custom: z
      .object({
        input: z.string(),
        name: z.string(),
      })
      .describe("Custom tool call details"),
  })
  .describe("A custom tool call in the message");

export const ToolCallSchema = z
  .union([FunctionToolCallSchema, CustomToolCallSchema])
  .describe("A tool call in the assistant message");

const ContentPartRefusalSchema = z
  .object({
    type: z.enum(["refusal"]),
    refusal: z.string(),
  })
  .describe("A refusal content part");

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe("A text content part");

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
  .describe("An image content part");

const ContentPartInputAudioSchema = z
  .object({
    type: z.enum(["input_audio"]),
    input_audio: z
      .object({
        data: z.string(),
        format: z.enum(["wav", "mp3"]),
      })
      .describe("Audio input details"),
  })
  .describe("An audio content part");

const ContentPartFileSchema = z
  .object({
    type: z.enum(["file"]),
    file: z
      .object({
        file_data: z.string().optional(),
        file_id: z.string().optional(),
        filename: z.string().optional(),
      })
      .describe("File details"),
  })
  .describe("A file content part");

const ContentPartSchema = z
  .union([
    ContentPartTextSchema,
    ContentPartImageSchema,
    ContentPartInputAudioSchema,
    ContentPartFileSchema,
  ])
  .describe("A content part in a message");

const DeveloperMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["developer"]),
    name: z.string().optional(),
  })
  .describe("A developer message");

const SystemMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
  })
  .describe("A system message");

const UserMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
  })
  .describe("A user message");

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    audio: z
      .object({
        id: z.string(),
      })
      .nullable()
      .optional(),
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
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe("An assistant message");

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.union([
      z.string(),
      z.array(z.union([ContentPartTextSchema, ContentPartImageSchema])),
    ]),
    tool_call_id: z.string(),
  })
  .describe("A tool result message");

const FunctionMessageParamSchema = z
  .object({
    role: z.enum(["function"]),
    content: z.string().nullable(),
    name: z.string(),
  })
  .describe("A function result message (deprecated)");

export const MessageParamSchema = z
  .union([
    DeveloperMessageParamSchema,
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
    FunctionMessageParamSchema,
  ])
  .describe("A message in the conversation");
