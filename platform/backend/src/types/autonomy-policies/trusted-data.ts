import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "../../database";
import { SupportedOperatorSchema } from "./operator";

export const SelectTrustedDataPolicySchema = createSelectSchema(
  schema.trustedDataPoliciesTable,
);
export const InsertTrustedDataPolicySchema = createInsertSchema(
  schema.trustedDataPoliciesTable,
  {
    operator: SupportedOperatorSchema,
  },
);

export type TrustedDataPolicy = z.infer<typeof SelectTrustedDataPolicySchema>;
export type InsertTrustedDataPolicy = z.infer<
  typeof InsertTrustedDataPolicySchema
>;
