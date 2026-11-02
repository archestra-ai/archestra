import { z } from "zod";

/**
 * The log row of a pass-through request: a call a provider's catch-all
 * proxy forwarded unchanged (moderations, files, batches, token counts).
 * The bodies are the JSON that went over the wire, capped in size; a body
 * past the cap, or one that was not JSON, is recorded by its size.
 */
export const PassthroughRequestSchema = z.object({
  method: z.string(),
  path: z.string(),
  query: z.string().optional(),
  content_type: z.string().optional(),
  content_length: z.number().int().nonnegative().optional(),
  body: z.unknown().optional(),
  truncated: z.boolean().optional(),
});

export const PassthroughResponseSchema = z.object({
  status: z.number().int(),
  content_type: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  body: z.unknown().optional(),
  truncated: z.boolean().optional(),
  streamed: z.boolean().optional(),
});
