import { ResourceVisibilityScopeSchema } from "@archestra/shared";
import { z } from "zod";
import { McpSkillResourceSchema } from "./mcp-skill";

export const ExternalMcpSkillListItemSchema = z.object({
  source: z.literal("external_mcp"),
  id: z.string().uuid(),
  catalogId: z.string().uuid(),
  mcpServerId: z.string().uuid(),
  scope: ResourceVisibilityScopeSchema,
  serverName: z.string(),
  icon: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  uri: z.string(),
  resources: z.array(McpSkillResourceSchema).nullable(),
  usageCount: z.number().int().nonnegative(),
  usageUserCount: z.number().int().nonnegative(),
  lastUsedAt: z.date().nullable(),
});

export const ExternalMcpSkillDetailSchema =
  ExternalMcpSkillListItemSchema.extend({
    content: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]),
        kind: z.enum(["script", "reference", "asset"]),
      }),
    ),
  });

export type ExternalMcpSkillListItem = z.infer<
  typeof ExternalMcpSkillListItemSchema
>;
export type ExternalMcpSkillDetail = z.infer<
  typeof ExternalMcpSkillDetailSchema
>;
