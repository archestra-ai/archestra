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

/**
 * Who an object's own read grants reach beyond specific people, as the
 * database derives it into `resource_permission_policies.read_audience`.
 */
export type ResourceReadAudience = z.infer<typeof ResourceReadAudienceSchema>;

// The generated read-access columns serve list predicates only and are never
// part of a policy payload.
export const ResourcePermissionPolicySchema = createSelectSchema(
  schema.resourcePermissionPoliciesTable,
  {
    resource: ManagedResourceSchema,
    scope: ResourcePermissionScopeSchema,
    grants: z.array(ResourcePermissionGrantSchema),
  },
).omit({ scopeId: true, readAudience: true, readSubjects: true });

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
   * Whether the caller may add everyone in the organization or a role, or
   * widen such a grant. Without it they can still keep, lower, or remove one.
   */
  canShareOrganizationWide: z.boolean(),
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

const ResourceReadAudienceSchema = z.enum(["personal", "team", "org"]);
