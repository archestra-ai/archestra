// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ManagedResourceSchema,
  PermissionSubjectSchema,
  ResourcePermissionActionSchema,
  ResourcePermissionGrantSchema,
  ResourcePermissionScopeSchema,
} from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ResourcePermissionPolicySchema = createSelectSchema(
  schema.resourcePermissionPoliciesTable,
  {
    resource: ManagedResourceSchema,
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
  resource: ManagedResourceSchema,
  scope: ResourcePermissionScopeSchema,
  name: z.string(),
  /**
   * The person who owns the object: its author, whose grant moves on an
   * ownership transfer. Null for the `*` policy, an object with no author,
   * and one a service account created.
   */
  ownerId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  grants: z.array(ResourcePermissionGrantSchema.extend({ name: z.string() })),
  inheritedGrants: z.array(
    ResourcePermissionGrantSchema.extend({
      name: z.string(),
      sourceScope: ResourcePermissionScopeSchema.optional(),
    }),
  ),
  effectiveActions: z.array(ResourcePermissionActionSchema),
  /**
   * Every subject that reaches the caller (their user, teams, roles and the
   * organization), so the editor can warn before a save removes the caller's
   * own access or leaves nobody able to manage.
   */
  actorSubjects: z.array(PermissionSubjectSchema),
});

export const PermissionSubjectOptionSchema = z.object({
  subject: PermissionSubjectSchema,
  name: z.string(),
  email: z.string().optional(),
});
