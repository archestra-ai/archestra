import { validateLimitShape } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export { validateLimitShape } from "@shared";

/**
 * Entity types that can have limits applied.
 *
 * `user` scopes a limit to a single identifiable human (chat UI sessions,
 * personal chat-api-keys, JWKS-authenticated external callers). Shared
 * resources like virtual API keys, team/org chat-api-keys never bill a user.
 *
 * `virtual_api_key` scopes a limit to a specific vkey regardless of which
 * downstream caller uses it — caps the integration key itself.
 */
// TODO: need to make a database migration to migrate agent -> profile
export const LimitEntityTypeSchema = z.enum([
  "organization",
  "team",
  "agent",
  "user",
  "virtual_api_key",
]);
export type LimitEntityType = z.infer<typeof LimitEntityTypeSchema>;

/**
 * Types of limits that can be applied
 */
export const LimitTypeSchema = z.enum([
  "token_cost",
  "mcp_server_calls",
  "tool_calls",
]);
export type LimitType = z.infer<typeof LimitTypeSchema>;

/**
 * Base database schema derived from Drizzle
 */
export const SelectLimitSchema = createSelectSchema(schema.limitsTable, {
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
  model: z.array(z.string()).nullable().optional(),
});
export const InsertLimitSchema = createInsertSchema(schema.limitsTable, {
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
  model: z.array(z.string()).nullable().optional(),
});
export const UpdateLimitSchema = createUpdateSchema(schema.limitsTable, {
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
  model: z.array(z.string()).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
});

/**
 * Refined types for better type safety and validation
 */
export const CreateLimitApiSchema = InsertLimitSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
}).refine(validateLimitShape, {
  message: "Invalid limit configuration for the specified limit type",
});

/**
 * Exported types
 */
export type Limit = z.infer<typeof SelectLimitSchema>;
export type InsertLimit = z.infer<typeof InsertLimitSchema>;
export type CreateLimitApi = z.infer<typeof CreateLimitApiSchema>;
export type CreateLimit = CreateLimitApi & { organizationId: string };
export type UpdateLimit = z.infer<typeof UpdateLimitSchema>;

/**
 * Helper type for limit usage tracking
 */
export interface LimitUsageInfo {
  limitId: string;
  currentUsage: number;
  limitValue: number;
  isExceeded: boolean;
  remainingUsage: number;
}

/**
 * Per-model usage breakdown for a limit
 */
export interface ModelUsageBreakdown {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/**
 * Limit with per-model usage breakdown
 */
export const LimitWithUsageSchema = SelectLimitSchema.extend({
  modelUsage: z
    .array(
      z.object({
        model: z.string(),
        tokensIn: z.number(),
        tokensOut: z.number(),
        cost: z.number(),
      }),
    )
    .optional(),
});

export type LimitWithUsage = z.infer<typeof LimitWithUsageSchema>;
