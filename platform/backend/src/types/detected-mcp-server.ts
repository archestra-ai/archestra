import { z } from "zod";
import { DETECTED_CLIENT_FAMILIES } from "@/utils/detected-mcp-server-names";

/**
 * An MCP server a client connected on its own, seen through the tools the LLM
 * proxy observed it declaring: one per (client family, label) in the
 * organization. Its id, `<family>.<label>`, is also the alias target a policy
 * names to govern it.
 */
export const DetectedMcpServerSchema = z.object({
  id: z.string(),
  label: z.string(),
  clientFamily: z.enum(DETECTED_CLIENT_FAMILIES),
  tools: z.array(
    z.object({
      id: z.string().uuid(),
      /** The name as the client spells it and as the tool row stores it. */
      name: z.string(),
      /** The tool's own name on its server, without the client's label. */
      toolName: z.string(),
    }),
  ),
  observerCount: z.number().int().nonnegative(),
  firstObservedAt: z.date(),
});

export type DetectedMcpServer = z.infer<typeof DetectedMcpServerSchema>;
