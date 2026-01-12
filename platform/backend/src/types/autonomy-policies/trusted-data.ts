import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SupportedOperatorSchema } from "./operator";

export const TrustedDataPolicyActionSchema = z.enum([
  "block_always",
  "mark_as_trusted",
  "mark_as_untrusted",
  "sanitize_with_dual_llm",
]);

export const ResultPolicyConditionSchema = z.object({
  key: z.string(),
  operator: SupportedOperatorSchema,
  value: z.string(),
});

export const SelectTrustedDataPolicySchema = createSelectSchema(
  schema.trustedDataPoliciesTable,
  {
    conditions: z.array(ResultPolicyConditionSchema),
    action: TrustedDataPolicyActionSchema,
  },
);
export const InsertTrustedDataPolicySchema = createInsertSchema(
  schema.trustedDataPoliciesTable,
  {
    conditions: z.array(ResultPolicyConditionSchema),
    action: TrustedDataPolicyActionSchema,
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type TrustedDataPolicy = z.infer<typeof SelectTrustedDataPolicySchema>;
export type InsertTrustedDataPolicy = z.infer<
  typeof InsertTrustedDataPolicySchema
>;

export type TrustedDataPolicyAction = z.infer<
  typeof TrustedDataPolicyActionSchema
>;

export type ResultPolicyCondition = z.infer<typeof ResultPolicyConditionSchema>;
