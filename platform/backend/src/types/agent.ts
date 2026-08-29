import {
  BLOCKED_PASSTHROUGH_HEADERS,
  BUILT_IN_AGENT_IDS,
  DOMAIN_VALIDATION_REGEX,
  HEADER_NAME_REGEX,
  HEADER_NAME_VALIDATION_MESSAGE,
  IncomingEmailSecurityModeSchema,
  MAX_DOMAIN_LENGTH,
  MAX_PASSTHROUGH_HEADERS,
  MAX_SUGGESTED_PROMPTS,
  SupportedProvidersSchema,
} from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SuggestedPromptInputSchema } from "./agent-suggested-prompt";
import { AgentLabelWithDetailsSchema } from "./label";
import { AgentBackgroundExecutionSchema } from "./runner";
import { SelectToolSchema } from "./tool";
import {
  type ResourceVisibilityScope,
  ResourceVisibilityScopeSchema,
} from "./visibility";

/**
 * Agent type:
 * - profile: External profiles for API gateway routing
 * - mcp_gateway: MCP gateway specific configuration
 * - llm_proxy: LLM proxy specific configuration
 * - agent: Internal agents with prompts for chat
 */
export const AgentTypeSchema = z.enum([
  "profile",
  "mcp_gateway",
  "llm_proxy",
  "agent",
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

/**
 * Agent types that can serve as an MCP gateway — the agents external MCP
 * clients register via the connect page (legacy `profile` agents serve both
 * gateway and proxy surfaces).
 */
export const GATEWAY_CAPABLE_AGENT_TYPES = [
  "mcp_gateway",
  "profile",
] as const satisfies readonly AgentType[];

export const AgentScopeSchema = ResourceVisibilityScopeSchema;
export type AgentScope = ResourceVisibilityScope;

export const ToolExposureModeSchema = z.enum(["full", "search_and_run_only"]);
export type ToolExposureMode = z.infer<typeof ToolExposureModeSchema>;

/**
 * What happens when someone starts a conversation with an agent whose tools
 * come from MCP servers they have no usable connection to.
 *
 * - `allow`  — nothing up front; the caller only learns about it when a tool
 *              from the unconnected server is actually invoked (default, and
 *              the behavior that predates this setting).
 * - `warn`   — the caller may still use the agent, but the chat surfaces which
 *              connections are missing before they send anything.
 * - `block`  — the agent cannot be started at all until every connection its
 *              tools need resolves for the caller.
 */
export const MissingCredentialBehaviorSchema = z.enum([
  "allow",
  "warn",
  "block",
]);
export type MissingCredentialBehavior = z.infer<
  typeof MissingCredentialBehaviorSchema
>;

/**
 * The agent fields a missing-credential readiness check needs. Any richer agent
 * shape satisfies it.
 */
export type ReadinessAgent = {
  id: string;
  missingCredentialBehavior: MissingCredentialBehavior;
  accessAllTools: boolean;
};

/** An MCP server an agent needs but the caller has no usable connection to. */
const MissingAgentConnectionSchema = z.object({
  catalogId: z.string(),
  catalogName: z.string(),
});

/**
 * Pre-flight answer to "can this caller actually run this agent's tools?".
 * Only computed for agents that opted out of `allow`, so an empty
 * `missingConnections` on a `warn`/`block` agent means the caller is fully
 * connected.
 */
export const AgentCredentialReadinessSchema = z.object({
  agentId: z.string(),
  missingCredentialBehavior: MissingCredentialBehaviorSchema,
  missingConnections: z.array(MissingAgentConnectionSchema),
});
export type AgentCredentialReadiness = z.infer<
  typeof AgentCredentialReadinessSchema
>;

export const AgentScopeFilterSchema = z.enum([
  "personal",
  "team",
  "org",
  "built_in",
]);
export type AgentScopeFilter = z.infer<typeof AgentScopeFilterSchema>;

// Built-in agent config — discriminated union by name
// Policy Configuration Subagent config
const PolicyConfigAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.POLICY_CONFIG),
  autoConfigureOnToolDiscovery: z.boolean(),
});

const DualLlmMainAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN),
  maxRounds: z.number().int().min(1).max(20),
});

const DualLlmQuarantineAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE),
});

const ContextCompactionAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION),
});

const ChatTitleGenerationAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION),
});

const AppRuntimeAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.APP_RUNTIME),
});

const AdvisorAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.ADVISOR),
});

// Discriminated union — add future built-in agents here
export const BuiltInAgentConfigSchema = z.discriminatedUnion("name", [
  PolicyConfigAgentConfigSchema,
  DualLlmMainAgentConfigSchema,
  DualLlmQuarantineAgentConfigSchema,
  ContextCompactionAgentConfigSchema,
  ChatTitleGenerationAgentConfigSchema,
  AppRuntimeAgentConfigSchema,
  AdvisorAgentConfigSchema,
]);

export type BuiltInAgentConfig = z.infer<typeof BuiltInAgentConfigSchema>;
export type PolicyConfigAgentConfig = z.infer<
  typeof PolicyConfigAgentConfigSchema
>;
export type DualLlmMainAgentConfig = z.infer<
  typeof DualLlmMainAgentConfigSchema
>;
export type DualLlmQuarantineAgentConfig = z.infer<
  typeof DualLlmQuarantineAgentConfigSchema
>;
export type ContextCompactionAgentConfig = z.infer<
  typeof ContextCompactionAgentConfigSchema
>;
export type ChatTitleGenerationAgentConfig = z.infer<
  typeof ChatTitleGenerationAgentConfigSchema
>;

// Team info schema for agent responses (just id and name)
export const AgentTeamInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const PassthroughHeaderSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(HEADER_NAME_REGEX, HEADER_NAME_VALIDATION_MESSAGE)
  .transform((h) => h.toLowerCase())
  .refine((h) => !BLOCKED_PASSTHROUGH_HEADERS.has(h), {
    message: "This header name is not allowed (hop-by-hop or protocol-level)",
  });

export const PassthroughHeadersSchema = z
  .array(PassthroughHeaderSchema)
  .max(MAX_PASSTHROUGH_HEADERS)
  .nullable()
  .optional();

// Extended field schemas for drizzle-zod
// agentType override is needed because the column uses text().$type<AgentType>()
// which drizzle-zod infers as z.string() instead of the narrower enum schema
const selectExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
  agentType: AgentTypeSchema,
  scope: AgentScopeSchema,
  toolExposureMode: ToolExposureModeSchema,
  missingCredentialBehavior: MissingCredentialBehaviorSchema,
  builtInAgentConfig: BuiltInAgentConfigSchema.nullable(),
  passthroughHeaders: z.array(z.string()).nullable(),
  backgroundExecution: AgentBackgroundExecutionSchema.nullable(),
};

const insertExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema.optional(),
  agentType: AgentTypeSchema.optional(),
  scope: AgentScopeSchema.optional(),
  toolExposureMode: ToolExposureModeSchema.optional(),
  missingCredentialBehavior: MissingCredentialBehaviorSchema.optional(),
  builtInAgentConfig: BuiltInAgentConfigSchema.nullable().optional(),
  passthroughHeaders: PassthroughHeadersSchema,
  backgroundExecution: AgentBackgroundExecutionSchema.nullable().optional(),
};

/**
 * Validates incoming email domain settings.
 * When incomingEmailEnabled is true and incomingEmailSecurityMode is "internal",
 * the incomingEmailAllowedDomain must be provided and match the domain regex.
 */
function validateIncomingEmailDomain(
  data: {
    incomingEmailEnabled?: boolean | null;
    incomingEmailSecurityMode?: string | null;
    incomingEmailAllowedDomain?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  // Only validate when email is enabled and mode is internal
  if (
    data.incomingEmailEnabled === true &&
    data.incomingEmailSecurityMode === "internal"
  ) {
    const domain = data.incomingEmailAllowedDomain?.trim();

    if (!domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Allowed domain is required when security mode is set to internal",
        path: ["incomingEmailAllowedDomain"],
      });
      return;
    }

    if (domain.length > MAX_DOMAIN_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Domain must not exceed ${MAX_DOMAIN_LENGTH} characters`,
        path: ["incomingEmailAllowedDomain"],
      });
      return;
    }

    if (!DOMAIN_VALIDATION_REGEX.test(domain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid domain format. Please enter a valid domain (e.g., company.com)",
        path: ["incomingEmailAllowedDomain"],
      });
    }
  }
}

const AgentRowSchema = createSelectSchema(
  schema.agentsTable,
  selectExtendedFields,
);

/**
 * Hot-path agent shape for the MCP gateway: the raw agents row plus labels,
 * without the tools/teams/knowledge/connector/author/prompt/resolved-LLM
 * hydration a full `Agent` carries. See `AgentModel.findGatewayAgentById`.
 */
const GatewayAgentSchema = AgentRowSchema.extend({
  labels: z.array(AgentLabelWithDetailsSchema),
});
export type GatewayAgent = z.infer<typeof GatewayAgentSchema>;

/**
 * Slim tool reference embedded in agent payloads. Full tool definitions
 * (parameters, policy fields, timestamps) are served by the dedicated
 * per-agent tools endpoints; embedding them here multiplied agent list
 * responses by the org's agent × tool fan-out, with the parameter JSON
 * schemas duplicated once per assignment.
 */
export const AgentToolRefSchema = SelectToolSchema.pick({
  id: true,
  agentId: true,
  catalogId: true,
  delegateToAgentId: true,
  name: true,
  rawName: true,
  description: true,
});
export type AgentToolRef = z.infer<typeof AgentToolRefSchema>;

export const SelectAgentSchema = AgentRowSchema.extend({
  tools: z.array(AgentToolRefSchema),
  teams: z.array(AgentTeamInfoSchema),
  // People the agent is shared with individually. A personal-scoped agent with
  // a non-empty list is shared, not private — the settings form reads the pair
  // as its Users choice.
  // Optional like authorName: only the read paths that surface sharing
  // populate it, so the many internal Agent assemblies stay unchanged.
  users: z
    .array(z.object({ id: z.string(), name: z.string(), email: z.string() }))
    .optional(),
  labels: z.array(AgentLabelWithDetailsSchema),
  authorName: z.string().nullable().optional(),
  authorEmail: z.string().nullable().optional(),
  knowledgeBaseIds: z.array(z.string()),
  connectorIds: z.array(z.string()),
  suggestedPrompts: z
    .array(SuggestedPromptInputSchema)
    .max(MAX_SUGGESTED_PROMPTS)
    .default([]),
  /**
   * The provider of the agent's configured default LLM, resolved server-side
   * from `llmApiKeyId` (or `modelId` when only a model is pinned) so every
   * viewer sees the agent's true provider — even one who can't access the
   * owner's per-user key. Null when the agent has no LLM configured. Populated
   * on read paths (list/get); absent on mutation responses (clients re-fetch).
   */
  resolvedLlmProvider: SupportedProvidersSchema.nullable().optional(),
  /**
   * The human-facing name of the agent's configured model (e.g. "gpt-4"),
   * resolved server-side from `modelId` so a viewer who can't access the
   * configured key still sees the model name rather than its UUID. Null when no
   * model is configured.
   */
  resolvedLlmModelName: z.string().nullable().optional(),
  /**
   * Whether the agent's configured provider requires a per-user credential
   * (e.g. GitHub Copilot). Lets the chat/dialog show a read-only model and
   * prompt the viewer to connect their own account instead of silently
   * substituting another model.
   */
  llmProviderRequiresPerUserCredential: z.boolean().optional(),
  /**
   * Whether the code-execution sandbox is usable for this agent by the
   * requesting user (`isSkillSandboxAvailableForAgent`: feature enabled +
   * `sandbox:execute` permission + the sandbox tools assigned/accessible). The
   * chat composer widens the accepted upload types to any file when true.
   * Populated on read paths (list/get); absent on mutation responses.
   */
  sandboxAvailable: z.boolean().optional(),
  /**
   * Timestamp of the most recent MCP request (any JSON-RPC method) routed
   * through this agent, from the mcp_tool_calls log. Null when nothing was
   * ever routed through it. Populated on paginated list reads; absent on
   * other responses.
   */
  lastUsedAt: z.date().nullable().optional(),
});

// Base schema without refinement - can be used with .partial()
export const InsertAgentSchemaBase = createInsertSchema(
  schema.agentsTable,
  insertExtendedFields,
)
  .extend({
    teams: z.array(z.string()).default([]),
    // Individuals the agent is shared with by name. Additive to the scope,
    // so a personal agent can reach a colleague without going team-wide.
    users: z.array(z.string()).default([]),
    labels: z.array(AgentLabelWithDetailsSchema).optional(),
    // Make organizationId optional - model will auto-assign if not provided
    organizationId: z.string().optional(),
    scope: AgentScopeSchema,
    knowledgeBaseIds: z.array(z.string()).default([]),
    connectorIds: z.array(z.string()).default([]),
    suggestedPrompts: z
      .array(SuggestedPromptInputSchema)
      .max(MAX_SUGGESTED_PROMPTS)
      .optional(),
  })
  .omit({
    id: true,
    slug: true,
    createdAt: true,
    updatedAt: true,
    authorId: true,
    isPersonalGateway: true,
    backgroundExecutionSecretId: true,
    // Which skills a gateway publishes over skill:// is decided by the
    // skill-assignment routes, which carry a `skill:read` floor. Accepting the
    // flag in the generic agent body would let a caller without that
    // permission flip a gateway to publish-all.
    accessAllSkills: true,
    // Server-managed head pointer into agent_versions — forked by
    // AgentVersionModel, never client-settable (a supplied value would corrupt
    // the version counter and can collide on the (agent_id, version) index).
    latestVersion: true,
  });

// Full schema with validation refinement
export const InsertAgentSchema = InsertAgentSchemaBase.superRefine(
  validateIncomingEmailDomain,
);

// Base schema without refinement - can be used with .partial()
export const UpdateAgentSchemaBase = createUpdateSchema(
  schema.agentsTable,
  insertExtendedFields,
)
  .extend({
    teams: z.array(z.string()).optional(),
    users: z.array(z.string()).optional(),
    labels: z.array(AgentLabelWithDetailsSchema).optional(),
    scope: AgentScopeSchema.optional(),
    knowledgeBaseIds: z.array(z.string()).optional(),
    connectorIds: z.array(z.string()).optional(),
    suggestedPrompts: z
      .array(SuggestedPromptInputSchema)
      .max(MAX_SUGGESTED_PROMPTS)
      .optional(),
  })
  .omit({
    id: true,
    slug: true,
    createdAt: true,
    updatedAt: true,
    authorId: true,
    isPersonalGateway: true,
    backgroundExecutionSecretId: true,
    // Which skills a gateway publishes over skill:// is decided by the
    // skill-assignment routes, which carry a `skill:read` floor. Accepting the
    // flag in the generic agent body would let a caller without that
    // permission flip a gateway to publish-all.
    accessAllSkills: true,
    // Server-managed head pointer into agent_versions — forked by
    // AgentVersionModel, never client-settable (a supplied value would corrupt
    // the version counter and can collide on the (agent_id, version) index).
    latestVersion: true,
  });

// Full schema with validation refinement
export const UpdateAgentSchema = UpdateAgentSchemaBase.superRefine(
  validateIncomingEmailDomain,
);

export const CloneAgentBodySchema = z.object({
  scope: AgentScopeSchema.optional().describe(
    "Visibility of the clone. Defaults to the source agent's scope.",
  ),
  teams: z
    .array(z.string())
    .optional()
    .describe(
      "Teams for a team-scoped clone. Defaults to the source agent's teams. Ignored unless the clone's scope resolves to 'team'.",
    ),
});

export type Agent = z.infer<typeof SelectAgentSchema>;
export type AgentAccessContext = Pick<
  Agent,
  "id" | "organizationId" | "scope" | "authorId"
>;
export type InsertAgent = z.input<typeof InsertAgentSchema>;
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;

/**
 * Schema for auto-policy LLM analysis output.
 * Describes security policy recommendations for an MCP tool.
 */
export const PolicyConfigSchema = z.object({
  toolInvocationAction: z
    .enum([
      "allow_when_context_is_sensitive",
      "block_when_context_is_sensitive",
      "require_approval",
      "block_always",
    ])
    .describe(
      "When should this tool be allowed to be invoked? " +
        "'allow_when_context_is_sensitive' - Allow invocation even when sensitive data is present (safe read-only tools). " +
        "'block_when_context_is_sensitive' - Block when sensitive data is present, allow only when context is safe (tools that could leak data). " +
        "'require_approval' - Require user confirmation before executing in chat; block in autonomous sessions (write/mutating tools that are not outright destructive: create/update/send/post/charge). " +
        "'block_always' - Never allow automatic invocation (obviously destructive tools whose name is solely dedicated to deleting or destroying data).",
    ),
  trustedDataAction: z
    .enum([
      "mark_as_safe",
      "mark_as_sensitive",
      "sanitize_with_dual_llm",
      "block_always",
    ])
    .describe(
      "How should the tool's results be treated? " +
        "'mark_as_safe' - Results are fully trusted and used directly (internal dev/config metadata, or external action tools that return no third-party content). " +
        "'mark_as_sensitive' - Results contain organizational data from internal self-hosted systems (Jira, GitHub, databases, internal APIs, file systems) that must not leak to external tools. " +
        "'sanitize_with_dual_llm' - Results come from untrusted external/third-party sources and may carry injected instructions; they are summarized through the Dual LLM workflow so the raw content never reaches the privileged model (web search, scraping/fetching arbitrary pages, untrusted inbound messages). " +
        "'block_always' - Results are blocked entirely (highly sensitive or dangerous output).",
    ),
  reasoning: z
    .string()
    .describe(
      "Brief explanation of why these settings were chosen for this tool.",
    ),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

/** Maps LLM-facing PolicyConfig enum values to the database-stored policy values. */
const TOOL_INVOCATION_ACTION_MAP: Record<
  PolicyConfig["toolInvocationAction"],
  | "allow_when_context_is_untrusted"
  | "block_when_context_is_untrusted"
  | "require_approval"
  | "block_always"
> = {
  allow_when_context_is_sensitive: "allow_when_context_is_untrusted",
  block_when_context_is_sensitive: "block_when_context_is_untrusted",
  require_approval: "require_approval",
  block_always: "block_always",
};

const TRUSTED_DATA_ACTION_MAP: Record<
  PolicyConfig["trustedDataAction"],
  | "mark_as_trusted"
  | "mark_as_untrusted"
  | "sanitize_with_dual_llm"
  | "block_always"
> = {
  mark_as_safe: "mark_as_trusted",
  mark_as_sensitive: "mark_as_untrusted",
  sanitize_with_dual_llm: "sanitize_with_dual_llm",
  block_always: "block_always",
};

export function mapToolInvocationAction(
  action: PolicyConfig["toolInvocationAction"],
) {
  return TOOL_INVOCATION_ACTION_MAP[action];
}

export function mapTrustedDataAction(
  action: PolicyConfig["trustedDataAction"],
) {
  return TRUSTED_DATA_ACTION_MAP[action];
}
