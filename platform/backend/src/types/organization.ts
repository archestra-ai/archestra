import { OrganizationAppearanceSchema } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectOrganizationSchema = createSelectSchema(
  schema.organizationsTable,
  OrganizationAppearanceSchema.shape,
);
export const InsertOrganizationSchema = createInsertSchema(
  schema.organizationsTable,
  OrganizationAppearanceSchema.shape,
);
export const UpdateOrganizationSchema = createUpdateSchema(
  schema.organizationsTable,
  OrganizationAppearanceSchema.shape,
);

export type Organization = z.infer<typeof SelectOrganizationSchema>;
export type InsertOrganization = z.infer<typeof InsertOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof UpdateOrganizationSchema>;
