/**
 * Ollama native `/api/chat` tool-definition wire types (api/types.go `Tool`).
 */
import { z } from "zod";

export const ToolSchema = z.looseObject({
  // Always "function" today; kept permissive for forward-compat.
  type: z.string(),
  function: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});
