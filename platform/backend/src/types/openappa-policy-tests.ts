import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { openappaPolicyTestRunsTable } from "@/database/schemas/openappa-policy-tests";
import { GuardrailsValidationSchema } from "./guardrails-policy";

export const PolicyTestDirectorySchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine(
    (path) => !path.split("/").some((part) => part === "." || part === ".."),
    "Use a repository-relative directory",
  );
export const PolicyTestFileSchema = z.strictObject({
  path: PolicyTestDirectorySchema.refine(
    (path) => path.endsWith(".appa"),
    "Validation files must end in .appa",
  ),
  content: z
    .string()
    .max(65536)
    .refine(
      (content) => Buffer.byteLength(content) <= 65536,
      "Validation file exceeds 64 KiB",
    ),
});
export const PolicyTestFilesSchema = z
  .array(PolicyTestFileSchema)
  .max(32)
  .refine(
    (files) => new Set(files.map((file) => file.path)).size === files.length,
    "Validation file paths must be unique",
  )
  .refine(
    (files) =>
      files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) <=
      524288,
    "Validation collection exceeds 512 KiB",
  );
export type PolicyTestFile = z.infer<typeof PolicyTestFileSchema>;
export const InspectPolicyTestsSchema = z.strictObject({
  files: PolicyTestFilesSchema,
});
export const PolicyTestInspectionSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      tools: z.array(z.string()),
      assertionCount: z.number().int().nonnegative().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export const PolicyTestCollectionSchema = z.object({
  source: z.enum(["local", "github"]),
  files: PolicyTestFilesSchema,
  version: z.string(),
  sourceCommit: z.string().nullable(),
  directory: z.string(),
  activeDirectory: z.string(),
  error: z.string().nullable(),
});
export type PolicyTestCollection = z.infer<typeof PolicyTestCollectionSchema>;
export const PolicyTestResultSchema = z.object({
  path: z.string(),
  assertionCount: z.number().int().nonnegative(),
  status: z.enum(["passed", "failed", "cannot_run"]),
  error: z.string().nullable().optional(),
  contentHash: z.string(),
  steps: z.array(
    z.object({
      line: z.number().int().nonnegative(),
      tool: z.string(),
      expected: z.string(),
      actual: z.string().nullable(),
      status: z.enum(["passed", "failed", "cannot_run"]),
      error: z.string().nullable().optional(),
    }),
  ),
});
export const PolicyTestRunResultSchema = z.object({
  trigger: z.enum(["manual", "github_sync", "policy_change"]).optional(),
  executionError: z.string().optional(),
  source: z.enum(["local", "github"]),
  sourceVersion: z.string(),
  sourceCommit: z.string().nullable(),
  definitionHash: z.string(),
  policyRevision: z.number().int().nonnegative(),
  policyHash: z.string(),
  effectivePolicyHash: z.string(),
  engineVersion: z.string(),
  draft: z.boolean(),
  files: z.array(PolicyTestResultSchema),
  validation: GuardrailsValidationSchema,
});
export type PolicyTestRunResult = z.infer<typeof PolicyTestRunResultSchema>;
export const PolicyTestPreviewSchema = PolicyTestRunResultSchema.extend({
  stale: z.boolean(),
});
export const PolicyTestRunSchema = createSelectSchema(
  openappaPolicyTestRunsTable,
)
  .omit({ organizationId: true, result: true })
  .extend(PolicyTestRunResultSchema.shape)
  .extend({ stale: z.boolean() });
export const UpdatePolicyTestsSchema = z.strictObject({
  files: PolicyTestFilesSchema,
  expectedVersion: z.string(),
});
export const RunPolicyTestsSchema = z.strictObject({
  files: PolicyTestFilesSchema.refine(
    (files) => files.length > 0,
    "Select at least one validation file",
  ),
  sourceVersion: z.string(),
  directory: PolicyTestDirectorySchema.default("traces"),
});
export const PreviewPolicyTestSchema = RunPolicyTestsSchema.extend({
  files: PolicyTestFilesSchema.refine(
    (files) => files.length === 1,
    "An editor preview runs exactly one validation file",
  ),
});
