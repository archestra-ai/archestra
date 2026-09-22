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
  /** Valid, but composed degraded: a battery the document names governs nothing. */
  warnings: z.array(z.string()),
});
export type GuardrailsPolicy = z.infer<typeof GuardrailsPolicySchema>;

export const GuardrailsAnnotationRequestSchema = z.looseObject({
  version: z.literal(1),
  kind: z.literal("annotation"),
});
export const GuardrailsAnnotationSchema = z.object({
  version: z.literal(1),
  answer: z.object({
    delta: z.strictObject({}),
    requires: z.object({
      history: z.array(z.never()),
      attention: z.array(z.never()),
    }),
    emits: z.array(z.never()),
  }),
});
