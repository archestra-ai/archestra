// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  PermissionSubjectSchema,
  ResourcePermissionActionSchema,
  ResourcePermissionGrantSchema,
  ResourcePermissionScopeSchema,
  ScopedResourceSchema,
} from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ResourcePermissionPolicySchema = createSelectSchema(
  schema.resourcePermissionPoliciesTable,
  {
    resource: ScopedResourceSchema,
    scope: ResourcePermissionScopeSchema,
    grants: z.array(ResourcePermissionGrantSchema),
  },
);

export type ResourcePermissionPolicy = z.infer<
  typeof ResourcePermissionPolicySchema
>;

export const UpdateResourcePermissionPolicySchema = z.object({
  revision: z.number().int().nonnegative(),
  grants: z.array(ResourcePermissionGrantSchema).max(200),
});

export const ResourcePermissionsResponseSchema = z.object({
  resource: ScopedResourceSchema,
  scope: ResourcePermissionScopeSchema,
  name: z.string(),
  revision: z.number().int().nonnegative(),
  grants: z.array(ResourcePermissionGrantSchema.extend({ name: z.string() })),
  inheritedGrants: z.array(
    ResourcePermissionGrantSchema.extend({
      name: z.string(),
      sourceScope: ResourcePermissionScopeSchema.optional(),
    }),
  ),
  legacyAccess: z.array(
    ResourcePermissionGrantSchema.extend({ name: z.string() }),
  ),
  effectiveActions: z.array(ResourcePermissionActionSchema),
});

export const PermissionSubjectOptionSchema = z.object({
  subject: PermissionSubjectSchema,
  name: z.string(),
});
