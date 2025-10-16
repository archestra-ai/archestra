import { z } from "zod";
import { MessageSchema } from "./messages";
import { ToolSchema } from "./tools";

export const MessagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  max_tokens: z.number(),
  container: z.string().nullable().optional(),
  context_management: z.object().nullable().optional(),
  mcp_servers: z.array(z.any()).optional(),
  metadata: z
    .object({
      user_id: z.string().nullable(),
    })
    .optional(),
  service_tier: z.any().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  system: z.any().optional(),
  temperature: z.number().optional(),
  thinking: z.any().optional(),
  tool_choice: z.any().optional(),
  tools: z.array(ToolSchema).optional(),
  top_k: z.number().optional(),
  top_p: z.number().optional(),
});

// TODO: Implement
export const MessagesResponseSchema = z.any();

export const MessagesHeadersSchema = z
  .object({
    "user-agent": z
      .string()
      .optional()
      .describe("The user agent of the client"),
    "anthropic-version": z.string(),
    "x-api-key": z.string(),
  })
  .describe(`https://docs.claude.com/en/api/messages#parameter-anthropic-beta`);
