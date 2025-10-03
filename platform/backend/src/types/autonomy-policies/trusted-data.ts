import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "../../database";
import { SupportedOperatorSchema } from "./operator";

export const TrustedDataPolicyActionSchema = z.enum([
  "block_always",
  "mark_as_trusted",
]);

export const SelectTrustedDataPolicySchema = createSelectSchema(
  schema.trustedDataPoliciesTable,
  {
    operator: SupportedOperatorSchema,
    action: TrustedDataPolicyActionSchema,
  },
);
export const InsertTrustedDataPolicySchema = createInsertSchema(
  schema.trustedDataPoliciesTable,
  {
    operator: SupportedOperatorSchema,
    action: TrustedDataPolicyActionSchema,
  },
);

export type TrustedDataPolicy = z.infer<typeof SelectTrustedDataPolicySchema>;
export type InsertTrustedDataPolicy = z.infer<
  typeof InsertTrustedDataPolicySchema
>;

export type TrustedDataPolicyAction = z.infer<
  typeof TrustedDataPolicyActionSchema
>;
