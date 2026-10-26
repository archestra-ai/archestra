import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
} from "@archestra/shared";
import { z } from "zod";
import { LimitCleanupIntervalSchema } from "./limit";

/**
 * Where a user's effective spend limit comes from. Precedence matches
 * enforcement: a custom per-user limit, else the environment override, else
 * the organization default; `none` when nothing applies.
 */
export const UserLimitSourceSchema = z.enum([
  "custom",
  "environment_default",
  "organization_default",
  "none",
]);
export type UserLimitSource = z.infer<typeof UserLimitSourceSchema>;

/** `near` from 75% of the limit, `at` once spend reaches it (requests blocked). */
export const UserLimitStatusSchema = z.enum(["ok", "near", "at"]);
export type UserLimitStatus = z.infer<typeof UserLimitStatusSchema>;

export const UserLimitUsageFilterSchema = z.enum([
  "at",
  "near",
  "custom",
  "none",
]);
export type UserLimitUsageFilter = z.infer<typeof UserLimitUsageFilterSchema>;

export const UserLimitUsageQuerySchema = PaginationQuerySchema.extend({
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Match users by name or email."),
  environmentId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Only users who spent in this environment, with the limit that applies to their requests there.",
    ),
  status: UserLimitUsageFilterSchema.optional().describe(
    "Only users at or near their limit, on a custom limit, or with no limit.",
  ),
});
export type UserLimitUsageQuery = z.infer<typeof UserLimitUsageQuerySchema>;

export const UserLimitUsageSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  source: UserLimitSourceSchema,
  /** The environment whose override applies (source `environment_default`). */
  environmentId: z.string().nullable(),
  environmentName: z.string().nullable(),
  /** Dollars; null when no limit applies. */
  limitValue: z.number().nullable(),
  cleanupInterval: LimitCleanupIntervalSchema.nullable(),
  /** Models the limit covers; null means all models. */
  models: z.array(z.string()).nullable(),
  /** Dollars counted toward the limit this window. */
  spent: z.number(),
  /** Spend as a percentage of the limit; null when no limit applies. */
  percent: z.number().nullable(),
  status: UserLimitStatusSchema,
  /** Set for source `custom`: the limit row to edit or remove. */
  customLimitId: z.string().nullable(),
  customReason: z.string().nullable(),
  /** Start of the next window, for calendar intervals; null for rolling ones. */
  resetsAt: z.string().nullable(),
  /** Spend at window end at the current pace, for calendar intervals. */
  projectedSpend: z.number().nullable(),
  /**
   * For source `custom`: spend this window under the organization default,
   * which applies again if the custom limit is removed. Custom limits count
   * from when they were set, so this can differ from `spent`.
   */
  fallbackSpent: z.number().nullable(),
  /** When an admin last reset this user's usage, and who. */
  lastResetAt: z.string().nullable(),
  lastResetByName: z.string().nullable(),
});
export type UserLimitUsage = z.infer<typeof UserLimitUsageSchema>;

export const UserLimitUsageSummarySchema = z.object({
  total: z.number().int(),
  at: z.number().int(),
  near: z.number().int(),
  custom: z.number().int(),
  none: z.number().int(),
  organizationDefault: z.number().int(),
  environmentDefault: z.number().int(),
  /** Users at or near a custom limit (a subset of `at` + `near`). */
  flaggedCustom: z.number().int(),
  /** Dollars spent by everyone counted in `total`. */
  spent: z.number(),
  /** Next reset of the organization default, for calendar intervals. */
  resetsAt: z.string().nullable(),
  /**
   * Per environment: users who spent there this window, and (for an
   * environment with an override) how many of them are at or near it.
   */
  environments: z.array(
    z.object({
      environmentId: z.string(),
      users: z.number().int(),
      at: z.number().int(),
      near: z.number().int(),
    }),
  ),
});
export type UserLimitUsageSummary = z.infer<typeof UserLimitUsageSummarySchema>;

export const UserLimitUsageResponseSchema = createPaginatedResponseSchema(
  UserLimitUsageSchema,
).extend({
  /** Counts across every matching user, before the status filter. */
  summary: UserLimitUsageSummarySchema,
});
