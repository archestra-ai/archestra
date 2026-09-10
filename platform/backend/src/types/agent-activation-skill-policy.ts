import { z } from "zod";
import {
  AgentActivationSkillReferenceSchema,
  AgentActivationSkillSchema,
} from "./agent-activation-skill";

export const AgentActivationSkillModeSchema = z.enum(["all", "manual"]);
export type AgentActivationSkillMode = z.infer<
  typeof AgentActivationSkillModeSchema
>;

export const AgentActivationSkillRuleDispositionSchema = z.enum([
  "allow",
  "exclude",
]);
export type AgentActivationSkillRuleDisposition = z.infer<
  typeof AgentActivationSkillRuleDispositionSchema
>;

export type AgentActivationSkillSource = "native" | "external_mcp" | "plugin";

export const CreateAgentActivationSkillPolicySchema = z.object({
  mode: AgentActivationSkillModeSchema,
  allowedReferences: z
    .array(AgentActivationSkillReferenceSchema)
    .max(1000)
    .default([]),
  excludedReferences: z
    .array(AgentActivationSkillReferenceSchema)
    .max(1000)
    .default([]),
});

export const AgentActivationSkillPolicyOperationSchema = z.object({
  op: z.enum(["add", "remove"]),
  disposition: AgentActivationSkillRuleDispositionSchema,
  reference: AgentActivationSkillReferenceSchema,
});

export const PatchAgentActivationSkillPolicySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mode: AgentActivationSkillModeSchema.optional(),
    operations: z
      .array(AgentActivationSkillPolicyOperationSchema)
      .max(2000)
      .default([]),
    discardUnavailable: z
      .array(AgentActivationSkillRuleDispositionSchema)
      .max(2)
      .default([]),
  })
  .refine(
    ({ mode, operations, discardUnavailable }) =>
      mode !== undefined ||
      operations.length > 0 ||
      discardUnavailable.length > 0,
    { message: "At least one policy change is required" },
  );

export const AgentActivationSkillPolicyResponseSchema = z.object({
  mode: AgentActivationSkillModeSchema,
  revision: z.number().int().nonnegative(),
  allowedReferences: z.array(AgentActivationSkillReferenceSchema),
  excludedReferences: z.array(AgentActivationSkillReferenceSchema),
  allowedSkills: z.array(AgentActivationSkillSchema),
  excludedSkills: z.array(AgentActivationSkillSchema),
  hiddenAllowedCount: z.number().int().nonnegative(),
  hiddenExcludedCount: z.number().int().nonnegative(),
});

export type CreateAgentActivationSkillPolicy = z.infer<
  typeof CreateAgentActivationSkillPolicySchema
>;
export type AgentActivationSkillPolicyOperation = z.infer<
  typeof AgentActivationSkillPolicyOperationSchema
>;
export type PatchAgentActivationSkillPolicy = z.infer<
  typeof PatchAgentActivationSkillPolicySchema
>;
export type AgentActivationSkillPolicyResponse = z.infer<
  typeof AgentActivationSkillPolicyResponseSchema
>;
