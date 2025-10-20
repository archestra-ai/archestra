import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectMcpCatalogSchema = createSelectSchema(
  schema.mcpCatalogTable,
);
export const InsertMcpCatalogSchema = createInsertSchema(
  schema.mcpCatalogTable,
);
export const UpdateMcpCatalogSchema = createUpdateSchema(
  schema.mcpCatalogTable,
);

export type McpCatalog = z.infer<typeof SelectMcpCatalogSchema>;
export type InsertMcpCatalog = z.infer<typeof InsertMcpCatalogSchema>;
export type UpdateMcpCatalog = z.infer<typeof UpdateMcpCatalogSchema>;
