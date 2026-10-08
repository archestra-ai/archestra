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
  policyContent: ValidateGuardrailsPolicySchema.shape.content.optional(),
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
      .default("OpenAPPA policy and validation change proposed in chat."),
  });

export type PreviewOpenAppaValidationChange = z.infer<
  typeof PreviewOpenAppaValidationChangeSchema
>;
export type PublishOpenAppaValidationChange = z.infer<
  typeof PublishOpenAppaValidationChangeSchema
>;
