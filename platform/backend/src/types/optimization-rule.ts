import { SupportedProvidersSchema } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Content length optimization rule conditions
 * maxLength is measured in tokens (not characters)
 */
export const ContentLengthConditionsSchema = z.object({
  maxLength: z.number().int().positive(),
});

export const ToolPresenceConditionsSchema = z.object({
  hasTools: z.boolean(),
});

export const OptimizationRuleConditionsSchema = z
  .union([ContentLengthConditionsSchema, ToolPresenceConditionsSchema])
  .array();

export const OptimizationRuleEntityTypeSchema = z.enum([
  "organization",
  "team",
  "agent",
]);

const extendedFields = {
  entityType: OptimizationRuleEntityTypeSchema,
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

export type ContentLengthConditions = z.infer<
  typeof ContentLengthConditionsSchema
>;
export type ToolPresenceConditions = z.infer<
  typeof ToolPresenceConditionsSchema
>;
export type OptimizationRuleConditions = z.infer<
  typeof OptimizationRuleConditionsSchema
>;
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
