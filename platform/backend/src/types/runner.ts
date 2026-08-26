import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// ===================== Runner lifecycle =====================

/**
 * `pending` — row created, nothing provisioned yet.
 * `provisioning` — Kubernetes objects being created; pod not ready.
 * `running` — pod ready, agent process live.
 * `stopping` — teardown of a live runner in flight.
 * `stopped` — workload removed on purpose (TTL, idle, or explicit stop).
 * `failed` — provisioning or the agent process failed; `statusReason` explains.
 *
 * There is deliberately no scale-to-zero/hibernated state: a runner holds
 * in-memory session state that scaling down would destroy, so stopping is
 * always an explicit, user-visible outcome rather than a silent optimization.
 */
export const RunnerStateSchema = z.enum([
  "pending",
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "failed",
]);
export type RunnerState = z.infer<typeof RunnerStateSchema>;

/** States in which no Kubernetes workload should exist. */
export const RUNNER_TERMINAL_STATES: readonly RunnerState[] = [
  "stopped",
  "failed",
];

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

export const RunnerEventKindSchema = z.enum([
  "state_changed",
  "steer",
  "attached",
  "system",
]);
export type RunnerEventKind = z.infer<typeof RunnerEventKindSchema>;

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

/**
 * Fields carry no parse-time defaults on purpose: the column stores exactly
 * what an administrator configured, and the runtime applies deployment-level
 * fallbacks at spawn. A default applied here would make a parsed config differ
 * from the stored one.
 */
export const RunnerConfigSchema = z.object({
  /** Container image; omitted uses the platform default runner-agent image. */
  image: z.string().min(1).max(512).optional(),
  command: z.array(z.string()).optional(),
  steerMode: RunnerSteerModeSchema.optional(),
  /** Requires an admin to opt in; needed only by images running their own container runtime. */
  privileged: z.boolean().optional(),
  resources: RunnerResourcesSchema.optional(),
  ttlHours: z
    .number()
    .int()
    .positive()
    .max(24 * 90)
    .optional(),
  idleTimeoutMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 30)
    .optional(),
  credentials: z.array(RunnerCredentialDeclarationSchema).optional(),
  /** Non-secret environment variables passed through to the pod verbatim. */
  environment: z
    .array(z.object({ key: z.string().min(1), value: z.string() }))
    .optional(),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

// ===================== Database-derived types =====================

/**
 * drizzle-zod widens `$type<>` columns to plain strings, so each one is
 * restated here. Insert refinements additionally re-apply the optionality the
 * refinement would otherwise drop: a column with a database default, or a
 * nullable one, must stay omittable on insert.
 */
const runnerSelectRefinements = {
  state: RunnerStateSchema,
  steerMode: RunnerSteerModeSchema,
  resources: RunnerResourcesSchema.nullable(),
  command: z.array(z.string()).nullable(),
} as const;

const runnerInsertRefinements = {
  state: RunnerStateSchema.optional(),
  steerMode: RunnerSteerModeSchema.optional(),
  resources: RunnerResourcesSchema.nullish(),
  command: z.array(z.string()).nullish(),
} as const;

export const SelectRunnerSchema = createSelectSchema(
  schema.runnersTable,
  runnerSelectRefinements,
);
export const InsertRunnerSchema = createInsertSchema(
  schema.runnersTable,
  runnerInsertRefinements,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  nextEventSequence: true,
});
export const UpdateRunnerSchema = createUpdateSchema(schema.runnersTable, {
  state: RunnerStateSchema.optional(),
}).pick({
  name: true,
  state: true,
  statusReason: true,
  deploymentName: true,
  namespace: true,
  secretName: true,
  virtualApiKeyId: true,
  lastActivityAt: true,
  startedAt: true,
  stoppedAt: true,
});

export type Runner = z.infer<typeof SelectRunnerSchema>;
export type InsertRunner = z.infer<typeof InsertRunnerSchema>;
export type UpdateRunner = z.infer<typeof UpdateRunnerSchema>;

export const SelectRunnerEventSchema = createSelectSchema(
  schema.runnerEventsTable,
  {
    kind: RunnerEventKindSchema,
    payload: z.record(z.string(), z.unknown()).nullable(),
  },
);
export const InsertRunnerEventSchema = createInsertSchema(
  schema.runnerEventsTable,
  {
    kind: RunnerEventKindSchema,
    payload: z.record(z.string(), z.unknown()).nullish(),
  },
).omit({ id: true, createdAt: true, sequence: true });

export type RunnerEvent = z.infer<typeof SelectRunnerEventSchema>;
export type InsertRunnerEvent = z.infer<typeof InsertRunnerEventSchema>;

export const SelectUserCredentialSchema = createSelectSchema(
  schema.userCredentialsTable,
);
export type UserCredential = z.infer<typeof SelectUserCredentialSchema>;
