import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { guardrailsPolicyRevisionsTable } from "@/database/schemas/guardrails-policy";
import { GuardrailsPolicyContentSchema } from "./guardrails-policy-proposal";

export const UnsupportedAppaClientActionSchema = z.enum(["bypass", "block"]);
export type UnsupportedAppaClientAction = z.infer<
  typeof UnsupportedAppaClientActionSchema
>;

/**
 * What happens to a call waiting for human approval: it waits for a person
 * (`block`), or the platform lets it through and records a yell in sessions
 * no person answers for (`unattended`: Agent Runtime runs, workloads, and any
 * request sending the unattended header) or in every session (`everywhere`).
 */
export const HumanApprovalModeSchema = z.enum([
  "block",
  "unattended",
  "everywhere",
]);
export type HumanApprovalMode = z.infer<typeof HumanApprovalModeSchema>;

/**
 * What happens to a call no remedy can lift: it is refused (`refuse`), or the
 * platform lets it through and records a yell (`allow`). The `blocked` mark is
 * always refused.
 */
export const UnapprovableBlockModeSchema = z.enum(["refuse", "allow"]);
export type UnapprovableBlockMode = z.infer<typeof UnapprovableBlockModeSchema>;

export const GuardrailsModeSchema = z.enum(["off", "observe", "enforce"]);
export type GuardrailsMode = z.infer<typeof GuardrailsModeSchema>;

/**
 * Who answers what a person would be asked, in Enforce: the person (`ask`),
 * or the platform, in sessions an Agent Runtime credential opened
 * (`auto_unattended`) or in every session (`auto_everywhere`).
 */
export const PersonApprovalSchema = z.enum([
  "ask",
  "auto_unattended",
  "auto_everywhere",
]);
export type PersonApproval = z.infer<typeof PersonApprovalSchema>;

/** Attention marks the Observe approver never attends. */
export const EnforcedMarksSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(64)
  .refine((marks) => new Set(marks).size === marks.length, "Duplicate mark");

export const GuardrailsPolicySchema = createSelectSchema(
  guardrailsPolicyRevisionsTable,
).extend({ updatedAt: z.coerce.date().nullable() });
export const ValidateGuardrailsPolicySchema = z.strictObject({
  content: GuardrailsPolicyContentSchema.min(1),
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
