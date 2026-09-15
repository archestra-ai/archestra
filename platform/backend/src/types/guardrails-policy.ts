import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { guardrailsPolicyRevisionsTable } from "@/database/schemas/guardrails-policy";

export const GuardrailsPolicySchema = createSelectSchema(
  guardrailsPolicyRevisionsTable,
).extend({ updatedAt: z.coerce.date().nullable() });
export const ValidateGuardrailsPolicySchema = z.strictObject({
  content: z.string().min(1).max(262144),
});
export const UpdateGuardrailsPolicySchema =
  ValidateGuardrailsPolicySchema.extend({
    expectedRevision: z.number().int().nonnegative(),
  });
export const GuardrailsValidationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
});
export type GuardrailsPolicy = z.infer<typeof GuardrailsPolicySchema>;
