/**
 * DeepSeek Tool Types
 *
 * DeepSeek uses OpenAI-compatible tool definitions.
 */
import { z } from "zod";

export const FunctionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()),
});

export const ToolSchema = z.object({
  type: z.enum(["function"]),
  function: FunctionSchema,
});

export const ToolChoiceOptionSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  }),
]);

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.enum(["function"]),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
