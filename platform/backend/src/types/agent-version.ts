import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SelectAgentSchema } from "./agent";

/**
 * Canonical, hashable payload of an agent version — the agent's *config only*.
 *
 * Deliberately excluded (live-only state, never part of history):
 * - sharing: scope, teams, labels
 * - identity/singletons: slug, isDefault, isPersonalGateway, isPersonalProxy
 * - ownership/lifecycle: organizationId, authorId, timestamps, deletedAt
 * - limits, optimization rules, and per-tool policies (separate entities
 *   keyed by agent/tool id, not owned by the agent's config surface)
 *
 * Enum-ish fields are plain strings on purpose: snapshots are immutable
 * historical data and must keep parsing after an enum gains or loses values.
 * For the same reason, any field added later must be `.optional()` or
 * `.nullable()` so legacy rows still validate.
 *
 * Referenced entities are captured as id + human-readable name so history
 * stays legible after the referent is renamed or deleted.
 */
export const AgentConfigSnapshotSchema = z.object({
  agentType: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  considerContextUntrusted: z.boolean(),
  toolExposureMode: z.string(),
  accessAllTools: z.boolean(),
  accessAllSubagents: z.boolean(),
  /** Header NAMES only (no values) — safe to capture verbatim. */
  passthroughHeaders: z.array(z.string()),
  incomingEmailEnabled: z.boolean(),
  incomingEmailSecurityMode: z.string(),
  incomingEmailAllowedDomain: z.string().nullable(),
  builtInAgentConfig: z.unknown(),
  /** Resolved model identity (modelId FK + human-readable externalId). */
  model: z.object({ id: z.string(), externalId: z.string() }).nullable(),
  /** Redacted key identity — never key material (secret ids are excluded). */
  llmApiKey: z
    .object({ id: z.string(), name: z.string(), provider: z.string() })
    .nullable(),
  identityProviderId: z.string().nullable(),
  environmentId: z.string().nullable(),
  tools: z.array(
    z.object({
      toolId: z.string(),
      name: z.string(),
      mcpServerId: z.string().nullable(),
      credentialResolutionMode: z.string(),
    }),
  ),
  excludedTools: z.array(z.object({ toolId: z.string(), name: z.string() })),
  excludedSubagents: z.array(
    z.object({ agentId: z.string(), name: z.string() }),
  ),
  suggestedPrompts: z.array(
    z.object({ summaryTitle: z.string(), prompt: z.string() }),
  ),
  hooks: z.array(
    z.object({
      event: z.string(),
      fileName: z.string(),
      content: z.string(),
      requirements: z.array(z.string()),
      enabled: z.boolean(),
    }),
  ),
  knowledgeBases: z.array(z.object({ id: z.string(), name: z.string() })),
  connectors: z.array(z.object({ id: z.string(), name: z.string() })),
});

export type AgentConfigSnapshot = z.infer<typeof AgentConfigSnapshotSchema>;

export const SelectAgentVersionSchema = createSelectSchema(
  schema.agentVersionsTable,
  { snapshot: AgentConfigSnapshotSchema },
);

export type AgentVersion = z.infer<typeof SelectAgentVersionSchema>;

/**
 * List projection of a version: everything but the heavy `snapshot` payload,
 * so history lists stay cheap while get-one carries the full config.
 */
export const AgentVersionMetadataSchema = SelectAgentVersionSchema.omit({
  snapshot: true,
});

export type AgentVersionMetadata = z.infer<typeof AgentVersionMetadataSchema>;

export const RestoreAgentVersionBodySchema = z.object({
  /**
   * The head version the client previewed the restore against. If the agent's
   * head has moved past it by the time the restore runs, the request is
   * rejected with 409 instead of silently overwriting the newer config.
   */
  expectedHeadVersion: z.number().int().positive().optional(),
});

/**
 * A snapshot reference that could not be replayed — the referent was deleted,
 * renamed out of reach, or the caller may no longer assign it. The restore
 * proceeds without it (mirroring agent import's soft-warning contract); for
 * singular references the agent's current value is kept.
 */
export const RestoreVersionWarningSchema = z.object({
  type: z.enum([
    "config",
    "tool",
    "model",
    "llmApiKey",
    "identityProvider",
    "environment",
    "knowledgeBase",
    "connector",
    "hook",
  ]),
  name: z.string(),
  message: z.string(),
});

export type RestoreVersionWarning = z.infer<typeof RestoreVersionWarningSchema>;

export const RestoreAgentVersionResponseSchema = z.object({
  agent: SelectAgentSchema,
  warnings: z.array(RestoreVersionWarningSchema),
});
