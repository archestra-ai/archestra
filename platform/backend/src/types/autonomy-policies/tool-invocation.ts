import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SupportedOperatorSchema } from "./operator";

const ToolInvocationPolicyActionSchema = z.enum([
  "allow_when_context_is_untrusted",
  "block_when_context_is_untrusted",
  "block_always",
]);

const CallPolicyConditionSchema = z.object({
  key: z.string(),
  operator: SupportedOperatorSchema,
  value: z.string(),
});

const ConditionsSchema = z.array(CallPolicyConditionSchema);

export const SelectToolInvocationPolicySchema = createSelectSchema(
  schema.toolInvocationPoliciesTable,
  {
    conditions: ConditionsSchema,
    action: ToolInvocationPolicyActionSchema,
  },
);
export const InsertToolInvocationPolicySchema = createInsertSchema(
  schema.toolInvocationPoliciesTable,
  {
    conditions: ConditionsSchema,
    action: ToolInvocationPolicyActionSchema,
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ToolInvocationPolicy = z.infer<
  typeof SelectToolInvocationPolicySchema
>;
export type InsertToolInvocationPolicy = z.infer<
  typeof InsertToolInvocationPolicySchema
>;

export type ToolInvocationPolicyAction = z.infer<
  typeof ToolInvocationPolicyActionSchema
>;
