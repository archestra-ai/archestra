import { z } from "zod";

export const ToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    input_schema: z.record(z.string(), z.any()),
  })
  .describe(`https://docs.claude.com/en/api/messages#body-tools`);
