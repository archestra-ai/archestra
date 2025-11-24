import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SupportedProvidersSchema } from "./llm-providers";

/**
 * Content length optimization rule conditions
 * maxLength is measured in tokens (not characters)
 */
export const OptimizationRuleContentLengthConditionsSchema = z.object({
  maxLength: z.number().int().positive(),
});

export const OptimizationRuleToolPresenceConditionsSchema = z.object({
  hasTools: z.boolean(),
});

export const OptimizationRuleConditionsSchema = z.union([
  OptimizationRuleContentLengthConditionsSchema,
  OptimizationRuleToolPresenceConditionsSchema,
]);

export const OptimizationRuleTypeSchema = z.enum([
  "content_length",
  "tool_presence",
]);

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

export type OptimizationRuleContentLengthConditions = z.infer<
  typeof OptimizationRuleContentLengthConditionsSchema
>;
export type OptimizationRuleToolPresenceConditions = z.infer<
  typeof OptimizationRuleToolPresenceConditionsSchema
>;
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
