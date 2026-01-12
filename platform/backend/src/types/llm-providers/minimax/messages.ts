import { z } from "zod";

export const MessageParamSchema = z
  .object({
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.enum(["function", "custom"]),
          function: z
            .object({
              name: z.string(),
              arguments: z.string(),
            })
            .optional(),
          custom: z
            .object({
              name: z.string(),
              input: z.string(),
            })
            .optional(),
        }),
      )
      .optional(),
  })
  .describe(`MiniMax message parameter schema`);

export const ToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["function", "custom"]),
    function: z
      .object({
        name: z.string(),
        arguments: z.string(),
      })
      .optional(),
    custom: z
      .object({
        name: z.string(),
        input: z.string(),
      })
      .optional(),
  })
  .describe(`MiniMax tool call schema`);
