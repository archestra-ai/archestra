/**
 * DeepSeek Message Types
 *
 * DeepSeek uses OpenAI-compatible message formats.
 */
import { z } from "zod";
import { ToolCallSchema } from "./tools";

export { ToolCallSchema } from "./tools";

export const SystemMessageSchema = z.object({
  content: z.string(),
  role: z.enum(["system"]),
  name: z.string().optional(),
});

export const UserMessageSchema = z.object({
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
  role: z.enum(["user"]),
  name: z.string().optional(),
});

export const AssistantMessageSchema = z.object({
  content: z.string().nullable().optional(),
  refusal: z.string().nullable().optional(),
  role: z.enum(["assistant"]),
  name: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  // DeepSeek models might return reasoning content
  reasoning_content: z.string().nullable().optional(),
});

export const ToolMessageSchema = z.object({
  content: z.string(),
  role: z.enum(["tool"]),
  tool_call_id: z.string(),
});

export const FunctionMessageSchema = z.object({
  content: z.string().nullable(),
  role: z.enum(["function"]),
  name: z.string(),
});

export const MessageParamSchema = z.union([
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
  FunctionMessageSchema,
]);
