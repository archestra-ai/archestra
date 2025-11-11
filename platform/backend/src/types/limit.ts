import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Entity types that can have limits applied
 */
export const LimitEntityTypeSchema = z.enum(["organization", "team", "agent"]);
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
});
export const InsertLimitSchema = createInsertSchema(schema.limitsTable, {
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
});
export const UpdateLimitSchema = createUpdateSchema(schema.limitsTable, {
  entityType: LimitEntityTypeSchema,
  limitType: LimitTypeSchema,
}).omit({
  id: true,
  currentUsageTokensIn: true,
  currentUsageTokensOut: true,
  createdAt: true,
  updatedAt: true,
});

/**
 * Refined types for better type safety and validation
 */
export const CreateLimitSchema = InsertLimitSchema.omit({
  id: true,
  currentUsageTokensIn: true,
  currentUsageTokensOut: true,
  createdAt: true,
  updatedAt: true,
}).refine(
  (data) => {
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
    // Validation: token_cost requires model and should not have mcp or tool specificity
    if (data.limitType === "token_cost") {
      if (!data.model) {
        return false;
      }
      if (data.mcpServerName || data.toolName) {
        return false;
      }
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
