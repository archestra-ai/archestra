import type { IncomingEmailSecurityMode } from "@archestra/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  index,
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
  ToolExposureMode,
} from "@/types/agent";
import environmentsTable from "./environment";
import identityProvidersTable from "./identity-provider";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
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

    /** Allowlist of HTTP header names to forward from gateway requests to downstream MCP servers */
    passthroughHeaders: text("passthrough_headers").array(),

    /** Whether tools/list exposes the full tool menu or only meta-discovery tools */
    toolExposureMode: text("tool_exposure_mode")
      .$type<ToolExposureMode>()
      .notNull()
      .default("full"),

    /**
     * Whether search_tools/run_tool may dynamically discover and run tools the
     * calling user can access (MCP catalog tools and knowledge sources) beyond
     * the agent's assigned set. Nothing is assigned to the agent; the MCP
     * server's connection policy decides which credential each call uses. This
     * per-agent flag is the sole gate for dynamic tool access.
     */
    accessAllTools: boolean("access_all_tools").notNull().default(false),

    /** JSONB config for built-in agents (null for user-created agents) */
    builtInAgentConfig: jsonb(
      "built_in_agent_config",
    ).$type<BuiltInAgentConfig>(),

    /** Computed column: true when builtInAgentConfig is not null */
    builtIn: boolean("built_in").generatedAlwaysAs(
      (): SQL => sql`${agentsTable.builtInAgentConfig} IS NOT NULL`,
    ),

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
  ],
);

export default agentsTable;
