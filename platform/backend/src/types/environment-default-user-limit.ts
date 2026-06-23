import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { LimitCleanupIntervalSchema } from "./limit";

/**
 * Default token-cost limit applied per organization member. `environmentId` is
 * null for the organization-wide default, or set for a per-environment override.
 * See `database/schemas/environment-default-user-limits.ts`.
 */
export const SelectEnvironmentDefaultUserLimitSchema = createSelectSchema(
  schema.environmentDefaultUserLimitsTable,
  {
    model: z.array(z.string()).nullable().optional(),
    cleanupInterval: LimitCleanupIntervalSchema,
  },
);

/**
 * Request body for creating a default user limit. organizationId is taken from
 * the authenticated request context, not the body. Omit (or null) environmentId
 * to create/replace the organization-wide default; set it for a per-environment
 * override.
 */
export const CreateEnvironmentDefaultUserLimitSchema = createInsertSchema(
  schema.environmentDefaultUserLimitsTable,
  {
    environmentId: z.string().uuid().nullable().optional(),
    limitValue: z.number().int().positive(),
    model: z.array(z.string()).nullable().optional(),
    cleanupInterval: LimitCleanupIntervalSchema.optional(),
  },
).omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});

/**
 * Request body for updating a per-environment default user limit. environmentId
 * is intentionally immutable — moving a row to another environment would bypass
 * the unique-per-environment constraint and org-ownership validation.
 */
export const UpdateEnvironmentDefaultUserLimitSchema = createUpdateSchema(
  schema.environmentDefaultUserLimitsTable,
  {
    limitValue: z.number().int().positive(),
    model: z.array(z.string()).nullable().optional(),
    cleanupInterval: LimitCleanupIntervalSchema,
  },
)
  .pick({
    limitValue: true,
    model: true,
    cleanupInterval: true,
  })
  .partial();

export type EnvironmentDefaultUserLimit = z.infer<
  typeof SelectEnvironmentDefaultUserLimitSchema
>;
export type CreateEnvironmentDefaultUserLimit = z.infer<
  typeof CreateEnvironmentDefaultUserLimitSchema
>;
export type UpdateEnvironmentDefaultUserLimit = z.infer<
  typeof UpdateEnvironmentDefaultUserLimitSchema
>;
