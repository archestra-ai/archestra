import { z } from "zod";

export const ToolChoiceOptionSchema = z
  .object({
    type: z.enum(["auto", "none", "required"]),
    function: z
      .object({
        name: z.string(),
      })
      .optional(),
  })
  .describe(`MiniMax tool choice option schema`);

export const ToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.unknown()),
    }),
  })
  .describe(`MiniMax tool schema`);