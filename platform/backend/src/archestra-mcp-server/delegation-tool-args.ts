import { z } from "zod";

// Shared input cannot depend on the executor: the tool registry loads it while
// executor -> system prompt -> registry imports are still initializing.
export const delegationToolArgsSchema = z.object({
  message: z.string().trim().min(1, "message is required."),
  runtime_proof: z
    .string()
    .optional()
    .describe("Source-session proof supplied by the proxy."),
});
