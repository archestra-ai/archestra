import { z } from "zod";

export const GUARDRAILS_POLICY_MAX_LENGTH = 262144;

const GuardrailsPolicyEditSchema = z.strictObject({
  oldText: z
    .string()
    .describe(
      "Exact text copied from the current policy, including whitespace and line breaks. It must match one place unless replaceAll is true.",
    ),
  newText: z
    .string()
    .describe("The text that replaces oldText. Empty deletes oldText."),
  replaceAll: z
    .boolean()
    .nullish()
    .describe("Replace every match of oldText instead of exactly one."),
});

/**
 * The policy a preview or publish proposes: the complete text, or edits to the
 * revision `expectedRevision` names. Both fields accept empty values, because
 * models in strict function-calling mode fill the unused one with "", [] or null.
 */
export const ProposedGuardrailsPolicySchema = z.strictObject({
  content: z
    .string()
    .max(GUARDRAILS_POLICY_MAX_LENGTH)
    .nullish()
    .describe(
      "The complete policy text. Use it only for a first policy or a full rewrite. Leave it empty when you send edits.",
    ),
  edits: z
    .array(GuardrailsPolicyEditSchema)
    .max(50)
    .nullish()
    .describe(
      "Exact-text replacements applied in order to the current policy, each to the result of the one before. Use them to change an existing policy. To insert rules, replace an anchor line with the new rules followed by that same anchor line.",
    ),
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .describe("The revision get_guardrails_policy returned."),
});

export type GuardrailsPolicyEdit = z.infer<typeof GuardrailsPolicyEditSchema>;
export type GuardrailsPolicyProposal = Pick<
  z.infer<typeof ProposedGuardrailsPolicySchema>,
  "content" | "edits"
>;
