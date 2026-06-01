import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// === Public schemas & types ===

export const SelectEnvironmentSchema = createSelectSchema(
  schema.environmentsTable,
);

/**
 * Listing response shape — row columns plus the number of catalog items
 * currently assigned to this environment, for delete-confirmation UI.
 */
export const EnvironmentWithAssignedCountSchema =
  SelectEnvironmentSchema.extend({
    assignedCatalogCount: z.number().int().nonnegative(),
  });

/**
 * Full listing payload: the org's environments plus the count of catalog items
 * with no environment (which implicitly belong to the default environment).
 */
export const EnvironmentListSchema = z.object({
  environments: z.array(EnvironmentWithAssignedCountSchema),
  defaultAssignedCatalogCount: z.number().int().nonnegative(),
});

const KubernetesNamespaceSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "Must be a valid Kubernetes namespace name (lowercase letters, numbers, and hyphens only)",
  );

export const CreateEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(500).nullable().optional(),
  namespace: KubernetesNamespaceSchema.nullable().optional(),
  restricted: z.boolean().optional(),
});

/**
 * All editable fields. Send `null` to clear the nullable ones (namespace,
 * description).
 */
export const UpdateEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  namespace: KubernetesNamespaceSchema.nullable().optional(),
  restricted: z.boolean().optional(),
});

export type Environment = z.infer<typeof SelectEnvironmentSchema>;
export type EnvironmentWithAssignedCount = z.infer<
  typeof EnvironmentWithAssignedCountSchema
>;
export type EnvironmentList = z.infer<typeof EnvironmentListSchema>;
export type CreateEnvironment = z.infer<typeof CreateEnvironmentSchema>;
export type UpdateEnvironment = z.infer<typeof UpdateEnvironmentSchema>;
