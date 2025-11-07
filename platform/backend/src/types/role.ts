import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";

import { schema } from "@/database";

export const SelectOrganizationRoleSchema = createSelectSchema(
  schema.organizationRolesTable,
).extend({
  /**
   * Whether or not the role is "predefined" (not a custom one) or not
   * This dictates to clients whether or not the role is mutable
   */
  predefined: z.boolean(),
});
export const InsertOrganizationRoleSchema = createInsertSchema(
  schema.organizationRolesTable,
);

export const UpdateOrganizationRoleSchema = createUpdateSchema(
  schema.organizationRolesTable,
);

export type OrganizationRole = z.infer<typeof SelectOrganizationRoleSchema>;
export type InsertOrganizationRole = z.infer<
  typeof InsertOrganizationRoleSchema
>;
export type UpdateOrganizationRole = z.infer<
  typeof UpdateOrganizationRoleSchema
>;
