import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { LabelWithDetailsSchema } from "./label";

/**
 * Entity types that can have limits applied
 */
// TODO: need to make a database migration to migrate agent -> profile
export const LimitEntityTypeSchema = z.enum([
  "organization",
  "team",
  "agent",
  "user",
  "virtual_key",
  "environment",
  "llm_oauth_client",
]);
export type LimitEntityType = z.infer<typeof LimitEntityTypeSchema>;

/**
 * Types of limits that can be applied
 */
export const LimitTypeSchema = z.enum([
  "token_cost",
  "requests",
  "tokens",
  "requests_per_minute",
  "tokens_per_minute",
  "mcp_server_calls",
  "tool_calls",
]);
export type LimitType = z.infer<typeof LimitTypeSchema>;

export const LimitCleanupIntervalSchema = z.enum([
  "minute",
  "1h",
  "12h",
  "24h",
  "1w",
  "1m",
  "calendar_day",
  "calendar_week_sunday",
  "calendar_week_monday",
  "calendar_month",
]);
export type LimitCleanupInterval = z.infer<typeof LimitCleanupIntervalSchema>;
export const BudgetCleanupIntervalSchema = LimitCleanupIntervalSchema.exclude([
  "minute",
]);
export type BudgetCleanupInterval = z.infer<typeof BudgetCleanupIntervalSchema>;

/** Why an admin set a limit (shown with custom per-user limits). */
const LimitReasonSchema = z.string().trim().max(500).nullable().optional();

/**
 * Base database schema derived from Drizzle
 */
export const SelectLimitSchema = createSelectSchema(schema.limitsTable, {
  reason: z.string().nullable().optional(),
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
  model: z.array(z.string()).nullable().optional(),
  cleanupInterval: LimitCleanupIntervalSchema.optional(),
});
export const InsertLimitSchema = createInsertSchema(schema.limitsTable, {
  reason: LimitReasonSchema,
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
  model: z.array(z.string()).nullable().optional(),
  cleanupInterval: LimitCleanupIntervalSchema.optional(),
});
export const UpdateLimitSchema = createUpdateSchema(schema.limitsTable, {
  reason: LimitReasonSchema,
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
  model: z.array(z.string()).nullable().optional(),
  cleanupInterval: LimitCleanupIntervalSchema.optional(),
})
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({ labels: z.array(LabelWithDetailsSchema).optional() });

/**
 * Refined types for better type safety and validation
 */
export const CreateLimitSchema = InsertLimitSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({ labels: z.array(LabelWithDetailsSchema).optional() })
  .refine(
    (data) => {
      // Normalization is intentional: callers persist this parsed object with
      // empty model lists cleared and legacy rate intervals set to minute.
      // Validation: mcp_server_calls requires mcpServerName and should not have model
      if (data.limitType === "mcp_server_calls") {
        if (!data.mcpServerName) {
          return false;
        }
        if (data.model) {
          return false;
        }
      }
      // Validation: tool_calls requires both mcpServerName and toolName and should not have model
      if (data.limitType === "tool_calls") {
        if (!data.mcpServerName || !data.toolName) {
          return false;
        }
        if (data.model) {
          return false;
        }
      }
      // Validation: token_cost should not have mcp or tool specificity
      if (
        data.limitType === "token_cost" ||
        data.limitType === "requests" ||
        data.limitType === "tokens" ||
        data.limitType === "requests_per_minute" ||
        data.limitType === "tokens_per_minute"
      ) {
        if (data.mcpServerName || data.toolName) {
          return false;
        }
        if (
          !data.model ||
          !Array.isArray(data.model) ||
          data.model.length === 0
        ) {
          data.model = null;
        }
      }
      const throughput =
        data.limitType === "requests" ||
        data.limitType === "tokens" ||
        data.limitType === "requests_per_minute" ||
        data.limitType === "tokens_per_minute";
      const legacy = data.limitType.endsWith("_per_minute");
      if (
        (throughput || data.limitType === "token_cost") &&
        (!Number.isSafeInteger(data.limitValue) ||
          data.limitValue <
            (data.limitType === "token_cost" &&
            data.cleanupInterval !== "minute"
              ? 0
              : 1) ||
          data.limitValue > 2147483647)
      )
        return false;
      if (throughput || data.cleanupInterval === "minute") {
        if (
          !["organization", "team", "virtual_key"].includes(data.entityType) ||
          !Number.isSafeInteger(data.limitValue) ||
          data.limitValue <= 0 ||
          data.limitValue > 2147483647 ||
          (legacy && data.cleanupInterval && data.cleanupInterval !== "minute")
        )
          return false;
        if (legacy) data.cleanupInterval = "minute";
        if (!throughput && data.limitType !== "token_cost") return false;
      }
      return true;
    },
    {
      message: "Invalid limit configuration for the specified limit type",
    },
  );

/**
 * Exported types
 */
export type Limit = z.infer<typeof SelectLimitSchema>;
export type InsertLimit = z.infer<typeof InsertLimitSchema>;
export type CreateLimit = z.infer<typeof CreateLimitSchema>;
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
  throughputUsage: z
    .object({
      currentUsage: z
        .number()
        .describe(
          "Recorded usage. Token limits count only provider-reported tokens; requests already in flight can exceed the cap.",
        ),
      resetsAt: z
        .string()
        .describe(
          "Minute: projected full allowance recovery without new traffic. Other intervals: next reset.",
        ),
    })
    .optional(),
  labels: z.array(LabelWithDetailsSchema),
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
