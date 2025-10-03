import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "../../database";
import { SupportedOperatorSchema } from "./operator";

const ToolInvocationPolicyActionSchema = z.enum([
  "allow_when_context_is_untrusted",
  "block_always",
]);

export const SelectToolInvocationPolicySchema = createSelectSchema(
  schema.toolInvocationPoliciesTable,
  {
    operator: SupportedOperatorSchema,
    action: ToolInvocationPolicyActionSchema,
  },
);
export const InsertToolInvocationPolicySchema = createInsertSchema(
  schema.toolInvocationPoliciesTable,
  {
    operator: SupportedOperatorSchema,
    action: ToolInvocationPolicyActionSchema,
  },
);

export type ToolInvocationPolicy = z.infer<
  typeof SelectToolInvocationPolicySchema
>;
export type InsertToolInvocationPolicy = z.infer<
  typeof InsertToolInvocationPolicySchema
>;

export type ToolInvocationPolicyAction = z.infer<
  typeof ToolInvocationPolicyActionSchema
>;
