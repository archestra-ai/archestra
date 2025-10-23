import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectInternalMcpCatalogSchema = createSelectSchema(
  schema.internalMcpCatalogTable,
);
export const InsertInternalMcpCatalogSchema = createInsertSchema(
  schema.internalMcpCatalogTable,
);
export const UpdateInternalMcpCatalogSchema = createUpdateSchema(
  schema.internalMcpCatalogTable,
);

export type InternalMcpCatalog = z.infer<typeof SelectInternalMcpCatalogSchema>;
export type InsertInternalMcpCatalog = z.infer<
  typeof InsertInternalMcpCatalogSchema
>;
export type UpdateInternalMcpCatalog = z.infer<
  typeof UpdateInternalMcpCatalogSchema
>;
