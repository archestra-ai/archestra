import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AgentLabelWithDetailsSchema } from "./label";

/**
 * How a steer message reaches the running process.
 *
 * `pipe` — write to the runner-agent FIFO; the loop injects it at the next turn
 * boundary. Safe by construction: a message can never land mid-tool-call.
 * `tmux_keys` — type into the tmux session (`send-keys`). The bring-your-own-image
 * path for CLIs that own their own input loop, e.g. Claude Code.
 */
export const RunnerSteerModeSchema = z.enum(["pipe", "tmux_keys"]);
export type RunnerSteerMode = z.infer<typeof RunnerSteerModeSchema>;

export const RunnerResourcesSchema = z.object({
  cpuRequest: z.string().optional(),
  memoryRequest: z.string().optional(),
  /**
   * No CPU limit by default (matching the MCP server runtime): throttling an
   * agent loop mid-turn produces confusing timeouts rather than back-pressure.
   */
  cpuLimit: z.string().optional(),
  memoryLimit: z.string().optional(),
});
export type RunnerResources = z.infer<typeof RunnerResourcesSchema>;

// ===================== Credential declarations =====================

/**
 * `shared` — one organization-level value serves every user of the agent.
 * `per_user` — each invoking user supplies their own (`user_credentials`).
 *
 * `per_user` exists for credentials that carry an individual's identity
 * upstream: a personal Claude subscription token, a personal GitHub PAT. A
 * runner needing one cannot start until that specific user has deposited it,
 * which is why missing credentials surface as an actionable prompt rather than
 * an opaque failure.
 */
export const RunnerCredentialScopeSchema = z.enum(["shared", "per_user"]);
export type RunnerCredentialScope = z.infer<typeof RunnerCredentialScopeSchema>;

export const RunnerCredentialDeclarationSchema = z.object({
  /** Environment variable the resolved value is injected under. */
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Z_][A-Z0-9_]*$/,
      "Credential keys are environment variable names (A-Z, 0-9, underscore)",
    ),
  scope: RunnerCredentialScopeSchema,
  /** Human label shown when prompting a user to supply the credential. */
  label: z.string().min(1).max(200),
  /** How to obtain it, e.g. "Run `claude setup-token` and paste the result". */
  description: z.string().max(1000).optional(),
  required: z.boolean(),
});
export type RunnerCredentialDeclaration = z.infer<
  typeof RunnerCredentialDeclarationSchema
>;

/** One credential the invoking user still needs to supply. */
export const MissingRunnerCredentialSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type MissingRunnerCredential = z.infer<
  typeof MissingRunnerCredentialSchema
>;

/**
 * Machine-readable marker on the 409 returned when a spawn is blocked purely
 * for want of personal credentials. Clients key the "connect your credentials"
 * prompt off this rather than parsing prose.
 */
export const RUNNER_CREDENTIALS_REQUIRED_CODE = "RUNNER_CREDENTIALS_REQUIRED";

// ===================== Agent runner configuration =====================

export const RunnerEnvironmentEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type RunnerEnvironmentEntry = z.infer<
  typeof RunnerEnvironmentEntrySchema
>;

// ===================== Database-derived types =====================

/**
 * Column refinements: drizzle-zod widens `$type<>` columns to plain strings,
 * and the insert side additionally restores the optionality a refinement drops
 * for a column with a default or a nullable one.
 */
const runnerSelectRefinements = {
  steerMode: RunnerSteerModeSchema,
  resources: RunnerResourcesSchema.nullable(),
  command: z.array(z.string()).nullable(),
  environment: z.array(RunnerEnvironmentEntrySchema).nullable(),
  credentials: z.array(RunnerCredentialDeclarationSchema).nullable(),
} as const;

const runnerInsertRefinements = {
  steerMode: RunnerSteerModeSchema.optional(),
  resources: RunnerResourcesSchema.nullish(),
  command: z.array(z.string()).nullish(),
  environment: z.array(RunnerEnvironmentEntrySchema).nullish(),
  credentials: z.array(RunnerCredentialDeclarationSchema).nullish(),
} as const;

export const SelectRunnerSchema = createSelectSchema(
  schema.runnersTable,
  runnerSelectRefinements,
);
export const InsertRunnerSchema = createInsertSchema(
  schema.runnersTable,
  runnerInsertRefinements,
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateRunnerSchema = createUpdateSchema(
  schema.runnersTable,
  runnerInsertRefinements,
).omit({ id: true, organizationId: true, createdAt: true, updatedAt: true });

/** A runner as a list or detail response renders it: definition plus labels. */
export const SelectRunnerWithLabelsSchema = SelectRunnerSchema.extend({
  labels: z.array(AgentLabelWithDetailsSchema),
});

export type Runner = z.infer<typeof SelectRunnerSchema>;
export type RunnerWithLabels = z.infer<typeof SelectRunnerWithLabelsSchema>;
export type InsertRunner = z.infer<typeof InsertRunnerSchema>;
export type UpdateRunner = z.infer<typeof UpdateRunnerSchema>;

export const SelectRunnerSessionSchema = createSelectSchema(
  schema.runnerSessionsTable,
);
export const InsertRunnerSessionSchema = createInsertSchema(
  schema.runnerSessionsTable,
).omit({ id: true, startedAt: true });

export type RunnerSession = z.infer<typeof SelectRunnerSessionSchema>;
export type InsertRunnerSession = z.infer<typeof InsertRunnerSessionSchema>;

export const SelectUserCredentialSchema = createSelectSchema(
  schema.userCredentialsTable,
);
export type UserCredential = z.infer<typeof SelectUserCredentialSchema>;
