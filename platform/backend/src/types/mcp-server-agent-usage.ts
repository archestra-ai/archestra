import { createPaginatedResponseSchema } from "@archestra/shared";
import { z } from "zod";
import { McpServerAgentUsageSchema } from "./mcp-server";

export const McpAgentUsageEntrySchema = McpServerAgentUsageSchema.extend({
  access: z.enum(["assigned", "auto"]),
});

export const McpAgentUsagePageSchema = createPaginatedResponseSchema(
  McpAgentUsageEntrySchema,
).extend({
  catalogId: z.string().uuid(),
  assignedCount: z.number(),
  autoCount: z.number(),
  assignedPreview: z.array(McpAgentUsageEntrySchema),
  autoPreview: z.array(McpAgentUsageEntrySchema),
});

export type McpAgentUsagePage = z.infer<typeof McpAgentUsagePageSchema>;
