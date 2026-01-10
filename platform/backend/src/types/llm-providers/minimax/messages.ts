import { z } from "zod";

// MiniMax message schemas (OpenAI-compatible)
// Reference: https://platform.minimaxi.com/document/ChatCompletion%20v2

const SystemMessageSchema = z
  .object({
    role: z.enum(["system"]),
    content: z.string(),
    name: z.string().optional(),
  })
  .describe("System message for MiniMax API");

const UserMessageSchema = z
  .object({
    role: z.enum(["user"]),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          z.object({
            type: z.enum(["text"]),
            text: z.string(),
          }),
          z.object({
            type: z.enum(["image_url"]),
            image_url: z.object({
              url: z.string(),
              detail: z.enum(["auto", "low", "high"]).optional(),
            }),
          }),
        ]),
      ),
    ]),
    name: z.string().optional(),
  })
  .describe("User message for MiniMax API");

const AssistantToolCallFunctionSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.enum(["function"]),
  function: AssistantToolCallFunctionSchema,
});

const AssistantMessageSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe("Assistant message for MiniMax API");

const ToolMessageSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.unknown(),
    tool_call_id: z.string(),
  })
  .describe("Tool result message for MiniMax API");

export const MessageParamSchema = z.union([
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);
