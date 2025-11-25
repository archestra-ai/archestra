import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SupportedProvidersSchema } from "./llm-providers";

/**
 * Compound optimization rule conditions
 * Rules use AND logic: all specified conditions must match
 * maxLength is measured in tokens (not characters)
 */
export const OptimizationRuleConditionsSchema = z.object({
  maxLength: z.number().int().positive().optional(),
  hasTools: z.boolean().optional(),
});

export const OptimizationRuleTypeSchema = z.enum(["compound"]);

export const OptimizationRuleEntityTypeSchema = z.enum([
  "organization",
  "team",
  "agent",
]);

const extendedFields = {
  entityType: OptimizationRuleEntityTypeSchema,
  ruleType: OptimizationRuleTypeSchema,
  conditions: OptimizationRuleConditionsSchema,
  provider: SupportedProvidersSchema,
};

export const SelectOptimizationRuleSchema = createSelectSchema(
  schema.optimizationRulesTable,
  extendedFields,
);

export const InsertOptimizationRuleSchema = createInsertSchema(
  schema.optimizationRulesTable,
  extendedFields,
);
export const UpdateOptimizationRuleSchema = createUpdateSchema(
  schema.optimizationRulesTable,
  extendedFields,
);

export type OptimizationRuleConditions = z.infer<
  typeof OptimizationRuleConditionsSchema
>;
export type OptimizationRuleType = z.infer<typeof OptimizationRuleTypeSchema>;
export type OptimizationRuleEntityType = z.infer<
  typeof OptimizationRuleEntityTypeSchema
>;

export type OptimizationRule = z.infer<typeof SelectOptimizationRuleSchema>;
export type InsertOptimizationRule = z.infer<
  typeof InsertOptimizationRuleSchema
>;
export type UpdateOptimizationRule = z.infer<
  typeof UpdateOptimizationRuleSchema
>;
