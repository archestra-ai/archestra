import { z } from "zod";

const RoleSchema = z.enum(["user", "assistant", "chatbot", "system"]);

const TextContentSchema = z.object({
  type: z.enum(["text"]),
  text: z.string(),
});

const ToolCallContentSchema = z.object({
  type: z.enum(["tool_call"]),
  name: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  id: z.string(),
});

const ToolResultContentSchema = z.object({
  type: z.enum(["tool_result"]),
  tool_call_id: z.string(),
  result: z.union([z.string(), z.record(z.string(), z.unknown())]),
  is_error: z.boolean().optional(),
});

export const MessageContentBlockSchema = z.union([
  TextContentSchema,
  ToolCallContentSchema,
  ToolResultContentSchema,
]);

const MessageContentSchema = z.union([
  z.string(),
  z.array(MessageContentBlockSchema),
]);

export const MessageParamSchema = z.object({
  role: RoleSchema,
  content: MessageContentSchema,
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  tool_results: z
    .array(
      z.object({
        tool_call_id: z.string(),
        result: z.union([z.string(), z.record(z.string(), z.unknown())]),
        is_error: z.boolean().optional(),
      }),
    )
    .optional(),
});
