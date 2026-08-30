import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { A2ATaskStateSchema } from "./a2a-task";

/**
 * How a steer message reaches the running process.
 *
 * `pipe` — write to the execution-agent FIFO; the loop injects it at the next turn
 * boundary. Safe by construction: a message can never land mid-tool-call.
 * `tmux_keys` — type into the tmux session (`send-keys`). The bring-your-own-image
 * path for CLIs that own their own input loop, e.g. Claude Code.
 */
/**
 * Execution backends a Background execution configuration can name. One today;
 * the enum is the seam other
 * backends (a VM per task, an agent-sandbox) slot into without a schema change
 * anywhere above it.
 */
export const AgentDeploymentBackendSchema = z.enum(["kubernetes"]);
export type AgentDeploymentBackend = z.infer<
  typeof AgentDeploymentBackendSchema
>;

export const AgentRunActorKindSchema = z.enum([
  "user",
  "team",
  "organization",
  "system",
]);
export type AgentRunActorKind = z.infer<typeof AgentRunActorKindSchema>;

export const AgentDeploymentSteerModeSchema = z.enum(["pipe", "tmux_keys"]);
export type AgentDeploymentSteerMode = z.infer<
  typeof AgentDeploymentSteerModeSchema
>;

export const AgentDeploymentResourcesSchema = z.object({
  cpuRequest: z.string().optional(),
  memoryRequest: z.string().optional(),
  /**
   * No CPU limit by default (matching the MCP server runtime): throttling an
   * agent loop mid-turn produces confusing timeouts rather than back-pressure.
   */
  cpuLimit: z.string().optional(),
  memoryLimit: z.string().optional(),
});
export type AgentDeploymentResources = z.infer<
  typeof AgentDeploymentResourcesSchema
>;

/** Where a detached execution delivers its terminal result. */
export const AgentRunCompletionTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chatops"),
    bindingId: z.string().uuid(),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("email"),
    providerId: z.string().min(1),
    originalMessageId: z.string().min(1),
    fromAddress: z.string().email(),
    toAddress: z.string().email(),
    subject: z.string().nullable(),
  }),
]);
export type AgentRunCompletionTarget = z.infer<
  typeof AgentRunCompletionTargetSchema
>;

// ===================== Credential declarations =====================

/**
 * `shared` — one organization-level value serves every user of the agent.
 * `per_user` — each invoking user supplies their own (`user_credentials`).
 *
 * `per_user` exists for credentials that carry an individual's identity
 * upstream: a personal Claude subscription token, a personal GitHub PAT. A
 * background run needing one cannot start until that specific user has deposited it,
 * which is why missing credentials surface as an actionable prompt rather than
 * an opaque failure.
 */
export const AgentDeploymentCredentialScopeSchema = z.enum([
  "shared",
  "per_user",
]);
export type AgentDeploymentCredentialScope = z.infer<
  typeof AgentDeploymentCredentialScopeSchema
>;

export const AgentDeploymentCredentialDeclarationSchema = z.object({
  /** Environment variable the resolved value is injected under. */
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Z_][A-Z0-9_]*$/,
      "Credential keys are environment variable names (A-Z, 0-9, underscore)",
    ),
  scope: AgentDeploymentCredentialScopeSchema,
  /**
   * Stable connection identifier. Declarations sharing this identifier and
   * scope reuse one stored secret even when their environment variable names
   * differ. Omitted declarations retain the legacy per-Agent storage model.
   */
  credentialId: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[a-z][a-z0-9._-]*$/,
      "Credential IDs start with a letter and use lowercase letters, numbers, dots, dashes, or underscores",
    )
    .optional(),
  /** Human label shown when prompting a user to supply the credential. */
  label: z.string().min(1).max(200),
  /** How to obtain it, e.g. "Run `claude setup-token` and paste the result". */
  description: z.string().max(1000).optional(),
  required: z.boolean(),
});
export type AgentDeploymentCredentialDeclaration = z.infer<
  typeof AgentDeploymentCredentialDeclarationSchema
>;

/** One credential the invoking user still needs to supply. */
export const MissingAgentDeploymentCredentialSchema = z.object({
  key: z.string(),
  credentialId: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
});
export type MissingAgentDeploymentCredential = z.infer<
  typeof MissingAgentDeploymentCredentialSchema
>;

/**
 * Machine-readable marker on the 409 returned when a spawn is blocked purely
 * for want of personal credentials. Clients key the "connect your credentials"
 * prompt off this rather than parsing prose.
 */
export const AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED_CODE =
  "AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED";

// ===================== Agent Background execution configuration =====================

export const AgentDeploymentEnvironmentEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type AgentDeploymentEnvironmentEntry = z.infer<
  typeof AgentDeploymentEnvironmentEntrySchema
>;

/** Optional container deployment used only for delegated/background work. */
export const AgentBackgroundExecutionSchema = z.object({
  image: z.string().trim().min(1).max(2_000),
  command: z.array(z.string()).nullable(),
  /** Wire protocol the image uses to reach Archestra's model router. */
  inferenceProtocol: z.enum(["openai_responses", "openai_chat", "anthropic"]),
  backend: AgentDeploymentBackendSchema,
  steerMode: AgentDeploymentSteerModeSchema,
  privileged: z.boolean(),
  resources: AgentDeploymentResourcesSchema.nullable(),
  environment: z.array(AgentDeploymentEnvironmentEntrySchema).nullable(),
  credentials: z.array(AgentDeploymentCredentialDeclarationSchema).nullable(),
  ttlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .nullable(),
  /** Hard LLM spend ceiling for the short-lived virtual key backing one run. */
  maxCostUsd: z.number().int().min(1).max(100_000).nullable().optional(),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .nullable(),
});
export type AgentBackgroundExecution = z.infer<
  typeof AgentBackgroundExecutionSchema
>;

/** Runtime-ready deployment: Agent-owned config plus server-only associations. */
export type AgentDeployment = AgentBackgroundExecution & {
  agentId: string;
  organizationId: string;
  environmentId: string | null;
  secretId: string | null;
};

export const SelectAgentRunSchema = createSelectSchema(
  schema.agentRunsTable,
).extend({
  backend: AgentDeploymentBackendSchema,
  actorKind: AgentRunActorKindSchema,
  completionTarget: AgentRunCompletionTargetSchema.nullable(),
});
export const InsertAgentRunSchema = createInsertSchema(schema.agentRunsTable)
  .extend({
    backend: AgentDeploymentBackendSchema,
    actorKind: AgentRunActorKindSchema,
    completionTarget: AgentRunCompletionTargetSchema.nullable().optional(),
  })
  .omit({ id: true, startedAt: true, endedAt: true });

export const SelectAgentExecutionSchema = SelectAgentRunSchema.omit({
  logs: true,
  completionTarget: true,
  completionNotificationClaimedAt: true,
  completionNotifiedAt: true,
}).extend({
  state: A2ATaskStateSchema,
  statusReason: z.string().nullable(),
  stateChangedAt: z.date().nullable(),
});

/** A user's durable execution session as rendered in Chat and its sidebar. */
export const SelectAgentExecutionSessionSchema =
  SelectAgentExecutionSchema.extend({
    prompt: z.string(),
    agent: z.object({
      id: z.string().uuid(),
      name: z.string(),
      icon: z.string().nullable(),
    }),
  });

export const StartAgentExecutionResponseSchema = z.object({
  taskId: z.string().uuid(),
  state: A2ATaskStateSchema,
  agentId: z.string().uuid(),
  agentName: z.string(),
  prompt: z.string(),
  createdAt: z.date(),
});

export type AgentRun = z.infer<typeof SelectAgentRunSchema>;
export type InsertAgentRun = z.infer<typeof InsertAgentRunSchema>;
export type AgentExecution = z.infer<typeof SelectAgentExecutionSchema>;
export type AgentExecutionSession = z.infer<
  typeof SelectAgentExecutionSessionSchema
>;

export const SelectUserCredentialSchema = createSelectSchema(
  schema.userCredentialsTable,
);
export type UserCredential = z.infer<typeof SelectUserCredentialSchema>;
