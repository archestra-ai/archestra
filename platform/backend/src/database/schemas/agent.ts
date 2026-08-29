import type { IncomingEmailSecurityMode } from "@archestra/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentScope,
  AgentType,
  BuiltInAgentConfig,
  MissingCredentialBehavior,
  ToolExposureMode,
} from "@/types/agent";
import type { AgentBackgroundExecution } from "@/types/runner";
import environmentsTable from "./environment";
import identityProvidersTable from "./identity-provider";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
import secretsTable from "./secret";
import { softDeletablePgTable } from "./soft-deletable-table";
import usersTable from "./user";

/**
 * Unified agents table supporting both external profiles and internal agents.
 *
 * External profiles (agent_type = 'profile'):
 *   - API gateway profiles for routing LLM traffic
 *   - Used for tool assignment and policy enforcement
 *   - Prompt fields are null
 *
 * MCP Gateway (agent_type = 'mcp_gateway'):
 *   - MCP gateway specific configuration
 *
 * LLM Proxy (agent_type = 'llm_proxy'):
 *   - LLM proxy specific configuration
 *
 * Internal agents (agent_type = 'agent'):
 *   - Chat agents with system/user prompts
 *   - Can delegate to other internal agents via delegation tools
 *   - Can be triggered by ChatOps providers
 */
const agentsTable = softDeletablePgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    scope: text("scope").$type<AgentScope>().notNull().default("personal"),
    name: text("name").notNull(),
    slug: text("slug"),
    isDefault: boolean("is_default").notNull().default(false),
    isPersonalGateway: boolean("is_personal_gateway").notNull().default(false),
    isPersonalProxy: boolean("is_personal_proxy").notNull().default(false),
    considerContextUntrusted: boolean("consider_context_untrusted")
      .notNull()
      .default(false),
    agentType: text("agent_type")
      .$type<AgentType>()
      .notNull()
      .default("mcp_gateway"),
    // Prompt fields (only used when agentType = 'agent')
    systemPrompt: text("system_prompt"),
    // Description (only used when agentType = 'agent')
    /** Human-readable description of the agent */
    description: text("description"),

    /** Agent icon: emoji character or base64-encoded image data URL */
    icon: text("icon"),

    // Incoming email settings (only used when agentType = 'agent')
    /** Whether incoming email invocation is enabled for this agent */
    incomingEmailEnabled: boolean("incoming_email_enabled")
      .notNull()
      .default(false),
    /** Security mode for incoming email: 'private', 'internal', or 'public' */
    incomingEmailSecurityMode: text("incoming_email_security_mode")
      .$type<IncomingEmailSecurityMode>()
      .notNull()
      .default("private"),
    /** Allowed domain for 'internal' security mode (e.g., 'example.com') */
    incomingEmailAllowedDomain: text("incoming_email_allowed_domain"),

    // LLM configuration (allows per-agent model selection)
    /** API key ID for LLM calls */
    llmApiKeyId: uuid("llm_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      {
        onDelete: "set null",
      },
    ),
    /** @deprecated Superseded by `modelId` (FK). Retained, no longer read or written. */
    llmModel: text("llm_model"),
    /** FK to models(id) — the agent's default model. ON DELETE SET NULL. */
    modelId: uuid("model_id").references(() => modelsTable.id, {
      onDelete: "set null",
    }),

    /** Optional Identity Provider for JWKS-based JWT validation on MCP Gateway requests */
    identityProviderId: text("identity_provider_id").references(
      () => identityProvidersTable.id,
      { onDelete: "set null" },
    ),

    /**
     * Optional Environment whose runtime + egress NetworkPolicy this agent's
     * code sandbox runs under. Null = the shared/default runtime. The agent's
     * Dagger engine is provisioned per-environment and inherits the
     * environment's `networkPolicy` (same machinery as MCP server pods).
     * ON DELETE SET NULL — deleting an environment falls the agent back to the
     * default runtime rather than orphaning it.
     *
     * The FK is referential only; it does NOT encode org ownership, so the write
     * path that sets `agents.environment_id` validates the environment belongs to
     * the agent's organization (via `EnvironmentModel.findByIdForOrganization`)
     * to prevent cross-tenant binding.
     */
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "set null" },
    ),

    /**
     * Optional deployment used for durable/background work. Invocation
     * surfaces decide whether to request a foreground message or durable task.
     */
    backgroundExecution: jsonb(
      "background_execution",
    ).$type<AgentBackgroundExecution>(),
    /** Bag holding shared credential values declared by backgroundExecution. */
    backgroundExecutionSecretId: uuid(
      "background_execution_secret_id",
    ).references(() => secretsTable.id, { onDelete: "set null" }),

    /** Allowlist of HTTP header names to forward from gateway requests to downstream MCP servers */
    passthroughHeaders: text("passthrough_headers").array(),

    /** Whether tools/list exposes the full tool menu or only meta-discovery tools */
    toolExposureMode: text("tool_exposure_mode")
      .$type<ToolExposureMode>()
      .notNull()
      .default("full"),

    /**
     * How a shared agent behaves for a caller who has no usable connection to
     * one of the MCP servers its tools come from — the case where an agent is
     * shared org-wide but one of its servers is only connected personally by
     * its author. `allow` (the default) preserves the historical behavior: the
     * caller starts the conversation normally and only hits an error when a
     * tool from the unconnected server runs. `warn` and `block` move that
     * discovery to conversation start; `block` refuses the turn outright.
     *
     * Only meaningful for agents with explicitly assigned tools — under
     * `accessAllTools` ("Auto") every caller resolves their own tools, so
     * there is nothing to be missing.
     */
    missingCredentialBehavior: text("missing_credential_behavior")
      .$type<MissingCredentialBehavior>()
      .notNull()
      .default("allow"),

    /**
     * "Auto" tool mode (vs "Custom"): whether search_tools/run_tool may
     * dynamically discover and run tools the calling user can access (MCP
     * catalog tools and knowledge sources) beyond the agent's assigned set.
     * Nothing is assigned to the agent; the MCP server's default-credential
     * policy decides which credential each call uses. This per-agent flag is
     * the sole gate for dynamic tool access.
     */
    accessAllTools: boolean("access_all_tools").notNull().default(false),

    /**
     * "Auto" skill mode (vs "Custom"): whether the gateway's `skill://`
     * resource surface exposes every org-scoped skill visible in this agent's
     * environment (minus `agent_excluded_skills`) instead of only the skills
     * explicitly assigned in `agent_skills`. Org scope only — team and personal
     * skills never flow through Auto and must be Custom-assigned.
     */
    accessAllSkills: boolean("access_all_skills").notNull().default(false),

    /**
     * "Auto" subagent mode (vs "Custom"): whether this agent may delegate to
     * any internal agent the *calling user* can access (team/scope visibility),
     * beyond the explicitly-configured delegation targets. Mirrors
     * `accessAllTools` for agent-to-agent delegation. When on, delegation
     * targets are resolved dynamically per caller (minus `agent_excluded_subagents`);
     * when off, only explicitly-assigned delegation tools are exposed. This
     * per-agent flag is the sole gate for dynamic subagent access.
     */
    accessAllSubagents: boolean("access_all_subagents")
      .notNull()
      .default(false),

    /** JSONB config for built-in agents (null for user-created agents) */
    builtInAgentConfig: jsonb(
      "built_in_agent_config",
    ).$type<BuiltInAgentConfig>(),

    /** Computed column: true when builtInAgentConfig is not null */
    builtIn: boolean("built_in").generatedAlwaysAs(
      (): SQL => sql`${agentsTable.builtInAgentConfig} IS NOT NULL`,
    ),

    /**
     * Head pointer into `agent_versions`. 0 = legacy row that predates config
     * versioning; the first config write forks version 1. Bumped by
     * AgentVersionModel.forkIfChangedBestEffort at a config-mutating operation's
     * boundary (agent create/update, tool/hook/exclusion/knowledge edits); see
     * that model for the coverage surface and the lazy-capture caveat.
     */
    latestVersion: integer("latest_version").notNull().default(0),

    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("agents_slug_idx")
      .on(table.slug)
      .where(sql`${table.slug} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    index("agents_organization_id_idx").on(table.organizationId),
    index("agents_agent_type_idx").on(table.agentType),
    index("agents_identity_provider_id_idx").on(table.identityProviderId),
    index("agents_environment_id_idx").on(table.environmentId),
    index("agents_author_id_idx").on(table.authorId),
    index("agents_scope_idx").on(table.scope),
    uniqueIndex("agents_personal_gateway_per_member_idx")
      .on(table.organizationId, table.authorId)
      .where(
        sql`${table.agentType} = 'mcp_gateway' AND ${table.isPersonalGateway} = true AND ${table.deletedAt} IS NULL`,
      ),
    uniqueIndex("agents_personal_proxy_per_member_idx")
      .on(table.organizationId, table.authorId)
      .where(
        sql`${table.agentType} = 'llm_proxy' AND ${table.isPersonalProxy} = true AND ${table.deletedAt} IS NULL`,
      ),
    /**
     * One LLM Proxy per organization: the `llm_proxy` row with
     * `is_default = true` is THE organization's proxy, and every proxy
     * request resolves to it. Backs the race-safe ON CONFLICT ensure in
     * `AgentModel.getOrgLlmProxy`.
     */
    uniqueIndex("agents_org_default_llm_proxy_idx")
      .on(table.organizationId)
      .where(
        sql`${table.agentType} = 'llm_proxy' AND ${table.isDefault} = true AND ${table.deletedAt} IS NULL`,
      ),
  ],
);

export default agentsTable;
