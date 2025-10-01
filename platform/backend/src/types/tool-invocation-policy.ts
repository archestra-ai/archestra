import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "../database";

export const SelectToolInvocationPolicySchema = createSelectSchema(
  schema.toolInvocationPoliciesTable,
);
export const InsertToolInvocationPolicySchema = createInsertSchema(
  schema.toolInvocationPoliciesTable,
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
    action: z.enum(["allow", "block"]),
  },
);

export type ToolInvocationPolicy = z.infer<
  typeof SelectToolInvocationPolicySchema
>;
export type InsertToolInvocationPolicy = z.infer<
  typeof InsertToolInvocationPolicySchema
>;
