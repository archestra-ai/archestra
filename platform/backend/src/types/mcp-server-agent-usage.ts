import { createCursorPaginatedResponseSchema } from "@archestra/shared";
import { z } from "zod";
import { McpServerAgentUsageSchema } from "./mcp-server";

export const McpAutoModeAgentPageSchema = createCursorPaginatedResponseSchema(
  McpServerAgentUsageSchema,
).extend({
  totalAutoCount: z.number().int().nonnegative().optional(),
  organizationId: z.string().optional(),
});

export const AgentUsagePositionSchema = z.object({
  name: z.string(),
  email: z.string(),
  id: z.string().uuid(),
});
