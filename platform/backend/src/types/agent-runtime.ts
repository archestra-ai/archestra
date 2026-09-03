import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { A2ATaskStateSchema } from "./a2a-task";

/**
 * Runtime backends an Agent Runtime configuration can name. The enum is the
 * seam where other backends (a VM per task or a managed sandbox) can slot in
 * without changing the layers above it.
 */
export const AgentRuntimeBackendSchema = z.enum(["kubernetes"]);
export type AgentRuntimeBackend = z.infer<typeof AgentRuntimeBackendSchema>;

export const AgentRunActorKindSchema = z.enum([
  "user",
  "team",
  "organization",
  "system",
]);
export type AgentRunActorKind = z.infer<typeof AgentRunActorKindSchema>;

/** Non-lifecycle attention signal reported by a native runtime client. */
export const AgentRunAttentionStateSchema = z.enum([
  "input_required",
  "auth_required",
]);
export type AgentRunAttentionState = z.infer<
  typeof AgentRunAttentionStateSchema
>;

/**
 * How a steer message reaches the running process.
 *
 * `pipe` writes to the runtime-agent FIFO so the loop injects it at the next
 * turn boundary. `tmux_keys` types directly into the tmux session for CLIs
 * that own their own input loop, such as Claude Code.
 */
export const AgentRuntimeSteerModeSchema = z.enum(["pipe", "tmux_keys"]);
export type AgentRuntimeSteerMode = z.infer<typeof AgentRuntimeSteerModeSchema>;

export const AgentRuntimeResourcesSchema = z.object({
  cpuRequest: z.string().optional(),
  memoryRequest: z.string().optional(),
  /**
   * No CPU limit by default (matching the MCP server runtime): throttling an
   * agent loop mid-turn produces confusing timeouts rather than back-pressure.
   */
  cpuLimit: z.string().optional(),
  memoryLimit: z.string().optional(),
});
export type AgentRuntimeResources = z.infer<typeof AgentRuntimeResourcesSchema>;

/** Where a detached run delivers its terminal result. */
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
 * Agent Runtime run needing one cannot start until that user has deposited it,
 * which is why missing credentials surface as an actionable prompt rather than
 * an opaque failure.
 */
export const AgentRuntimeCredentialScopeSchema = z.enum(["shared", "per_user"]);
export type AgentRuntimeCredentialScope = z.infer<
  typeof AgentRuntimeCredentialScopeSchema
>;

export const AgentRuntimeCredentialDeclarationSchema = z.object({
  /** Environment variable the resolved value is injected under. */
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Z_][A-Z0-9_]*$/,
      "Credential keys are environment variable names (A-Z, 0-9, underscore)",
    ),
  scope: AgentRuntimeCredentialScopeSchema,
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
export type AgentRuntimeCredentialDeclaration = z.infer<
  typeof AgentRuntimeCredentialDeclarationSchema
>;

/** One credential the invoking user still needs to supply. */
export const MissingAgentRuntimeCredentialSchema = z.object({
  key: z.string(),
  credentialId: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
});
export type MissingAgentRuntimeCredential = z.infer<
  typeof MissingAgentRuntimeCredentialSchema
>;

/**
 * Machine-readable marker on the 409 returned when a spawn is blocked purely
 * for want of personal credentials. Clients key the "connect your credentials"
 * prompt off this rather than parsing prose.
 */
export const AGENT_RUNTIME_CREDENTIALS_REQUIRED_CODE =
  "AGENT_RUNTIME_CREDENTIALS_REQUIRED";

// ===================== Agent Runtime configuration =====================

export const AgentRuntimeEnvironmentEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type AgentRuntimeEnvironmentEntry = z.infer<
  typeof AgentRuntimeEnvironmentEntrySchema
>;

/** Optional dedicated container runtime for delegated and long-running work. */
export const AgentRuntimeSchema = z.object({
  image: z.string().trim().min(1).max(2_000),
  command: z.array(z.string()).nullable(),
  /** Wire protocol the image uses to reach Archestra's model router. */
  inferenceProtocol: z.enum(["openai_responses", "openai_chat", "anthropic"]),
  backend: AgentRuntimeBackendSchema,
  steerMode: AgentRuntimeSteerModeSchema,
  privileged: z.boolean(),
  resources: AgentRuntimeResourcesSchema.nullable(),
  environment: z.array(AgentRuntimeEnvironmentEntrySchema).nullable(),
  credentials: z.array(AgentRuntimeCredentialDeclarationSchema).nullable(),
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
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

/** Resolved runtime: Agent-owned config plus server-only associations. */
export type ResolvedAgentRuntime = AgentRuntime & {
  agentId: string;
  organizationId: string;
  environmentId: string | null;
  secretId: string | null;
};

export const SelectAgentRunRecordSchema = createSelectSchema(
  schema.agentRunsTable,
).extend({
  backend: AgentRuntimeBackendSchema,
  actorKind: AgentRunActorKindSchema,
  attentionState: z.union([AgentRunAttentionStateSchema, z.null()]),
  completionTarget: AgentRunCompletionTargetSchema.nullable(),
});
export const InsertAgentRunRecordSchema = createInsertSchema(
  schema.agentRunsTable,
)
  .extend({
    backend: AgentRuntimeBackendSchema,
    actorKind: AgentRunActorKindSchema,
    attentionState: z
      .union([AgentRunAttentionStateSchema, z.null()])
      .optional(),
    completionTarget: AgentRunCompletionTargetSchema.nullable().optional(),
  })
  .omit({ id: true, startedAt: true, endedAt: true });

export const SelectAgentRunSchema = SelectAgentRunRecordSchema.omit({
  logs: true,
  completionTarget: true,
  completionNotificationClaimedAt: true,
  completionNotifiedAt: true,
  activeDeadlineSeconds: true,
}).extend({
  state: A2ATaskStateSchema,
  statusReason: z.string().nullable(),
  stateChangedAt: z.date().nullable(),
  /** Effective Kubernetes lifetime limit, resolved for this run. */
  hardDeadlineAt: z.date(),
  /** Most recent model-router request attributed to this run. */
  lastModelActivityAt: z.date().nullable(),
});

/** A user's durable run session as rendered in Chat and its sidebar. */
export const SelectAgentRunSessionSchema = SelectAgentRunSchema.extend({
  prompt: z.string(),
  agent: z.object({
    id: z.string().uuid(),
    name: z.string(),
    icon: z.string().nullable(),
  }),
  projectName: z.string().nullable(),
  projectIcon: z.string().nullable(),
});

/**
 * How the requesting user relates to a run they're allowed to open.
 * `owner` started it and may attach interactively; `shared` was granted a
 * read-only view through a share and may only stream its logs.
 */
export const AgentRunViewerRoleSchema = z.enum(["owner", "shared"]);

/** A single run session plus the viewer's relationship to it. */
export const GetAgentRunResponseSchema = SelectAgentRunSessionSchema.extend({
  viewerRole: AgentRunViewerRoleSchema,
});

export const UpdateAgentRunSchema = createUpdateSchema(schema.agentRunsTable)
  .pick({ title: true, pinnedAt: true, projectId: true })
  .extend({
    title: z.string().trim().min(1).max(100).optional(),
    pinnedAt: z.string().datetime().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .refine(
    ({ title, pinnedAt, projectId }) =>
      title !== undefined || pinnedAt !== undefined || projectId !== undefined,
    "At least one field must be provided",
  );

export const StartAgentRunResponseSchema = z.object({
  taskId: z.string().uuid(),
  state: A2ATaskStateSchema,
  agentId: z.string().uuid(),
  agentName: z.string(),
  prompt: z.string(),
  projectId: z.string().uuid().nullable(),
  createdAt: z.date(),
});

export type AgentRunRecord = z.infer<typeof SelectAgentRunRecordSchema>;
export type InsertAgentRunRecord = z.infer<typeof InsertAgentRunRecordSchema>;
export type AgentRun = z.infer<typeof SelectAgentRunSchema>;
export type AgentRunSession = z.infer<typeof SelectAgentRunSessionSchema>;
export type AgentRunViewerRole = z.infer<typeof AgentRunViewerRoleSchema>;
export type GetAgentRunResponse = z.infer<typeof GetAgentRunResponseSchema>;

export const SelectUserCredentialSchema = createSelectSchema(
  schema.userCredentialsTable,
);
export type UserCredential = z.infer<typeof SelectUserCredentialSchema>;
