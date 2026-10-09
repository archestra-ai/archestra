import { z } from "zod";
import { ValidateGuardrailsPolicySchema } from "./guardrails-policy";
import {
  PolicyTestFileSchema,
  PolicyTestFilesSchema,
} from "./openappa-policy-tests";

export const PolicyTestChangesSchema = z
  .strictObject({
    upsert: PolicyTestFilesSchema.default([]),
    delete: z.array(PolicyTestFileSchema.shape.path).max(32).default([]),
  })
  .refine(
    (changes) => new Set(changes.delete).size === changes.delete.length,
    "Deleted paths must be unique",
  )
  .refine(
    (changes) =>
      !changes.upsert.some((file) => changes.delete.includes(file.path)),
    "A file cannot be written and deleted in the same proposal",
  );

export const PreviewOpenAppaValidationChangeSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  expectedVersion: z.string().min(1),
  changes: PolicyTestChangesSchema.default({ upsert: [], delete: [] }),
  policyContent: ValidateGuardrailsPolicySchema.shape.content
    .refine(
      (content) => content.trim().length > 0,
      "Policy content must not be blank; omit policyContent or pass null to keep the current policy",
    )
    .nullish()
    .describe(
      "Complete proposed root policy, only when the user explicitly requested a policy change. Omit or pass null for validation-only work. Never use an empty string, whitespace, or a copy of the current policy as a placeholder.",
    ),
});

export const PublishOpenAppaValidationChangeSchema =
  PreviewOpenAppaValidationChangeSchema.extend({
    title: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .default("Update OpenAPPA validations"),
    summary: z
      .string()
      .trim()
      .max(4000)
      .default("OpenAPPA changes proposed in chat."),
  });

export type PreviewOpenAppaValidationChange = z.infer<
  typeof PreviewOpenAppaValidationChangeSchema
>;
export type PublishOpenAppaValidationChange = z.infer<
  typeof PublishOpenAppaValidationChangeSchema
>;
