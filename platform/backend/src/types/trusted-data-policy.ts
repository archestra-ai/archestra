import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "../database";

export const SelectTrustedDataPolicySchema = createSelectSchema(
  schema.trustedDataPoliciesTable,
);
export const InsertTrustedDataPolicySchema = createInsertSchema(
  schema.trustedDataPoliciesTable,
  {
    operator: z.enum([
      "equal",
      "notEqual",
      "contains",
      "notContains",
      "startsWith",
      "endsWith",
      "regex",
    ]),
  },
);

export type TrustedDataPolicy = z.infer<typeof SelectTrustedDataPolicySchema>;
export type InsertTrustedDataPolicy = z.infer<
  typeof InsertTrustedDataPolicySchema
>;
