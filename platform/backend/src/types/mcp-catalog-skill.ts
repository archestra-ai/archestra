import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { McpSkillResourceSchema } from "./mcp-skill";

export const SelectMcpCatalogSkillSchema = createSelectSchema(
  schema.mcpCatalogSkillsTable,
  {
    frontmatter: z.record(z.string(), z.unknown()),
    resources: z.array(McpSkillResourceSchema).nullable(),
  },
);
export const InsertMcpCatalogSkillSchema = createInsertSchema(
  schema.mcpCatalogSkillsTable,
  {
    frontmatter: z.record(z.string(), z.unknown()),
    resources: z.array(McpSkillResourceSchema).nullable(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });

export type McpCatalogSkill = z.infer<typeof SelectMcpCatalogSkillSchema>;
export type InsertMcpCatalogSkill = z.infer<typeof InsertMcpCatalogSkillSchema>;
