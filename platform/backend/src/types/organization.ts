import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * NOTE: for now some of these fields are just strings, but we could convert this to enum in the future
 */
const OrganizationThemeSchema = z.string();
const OrganizationCustomFontSchema = z.string();
const OrganizationLogoTypeSchema = z.enum(["default", "custom"]);
const OrganizationLogoSchema = z.string();

export const OrganizationAppearanceSchema = z.object({
  theme: OrganizationThemeSchema.optional(),
  customFont: OrganizationCustomFontSchema.optional(),
  logoType: OrganizationLogoTypeSchema.optional(),
  logo: OrganizationLogoSchema.optional().nullable(),
});

const ExtenededOrganization = {
  theme: OrganizationThemeSchema,
  customFont: OrganizationCustomFontSchema,
  logoType: OrganizationLogoTypeSchema,
  logo: OrganizationLogoSchema,
};

export const SelectOrganizationSchema = createSelectSchema(
  schema.organizationsTable,
  ExtenededOrganization,
);
export const InsertOrganizationSchema = createInsertSchema(
  schema.organizationsTable,
  ExtenededOrganization,
);
export const UpdateOrganizationSchema = createUpdateSchema(
  schema.organizationsTable,
  ExtenededOrganization,
);

export type OrganizationAppearance = z.infer<
  typeof OrganizationAppearanceSchema
>;
export type Organization = z.infer<typeof SelectOrganizationSchema>;
export type InsertOrganization = z.infer<typeof InsertOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof UpdateOrganizationSchema>;
