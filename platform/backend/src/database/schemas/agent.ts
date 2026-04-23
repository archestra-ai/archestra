import type { IncomingEmailSecurityMode } from "@shared";
import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
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
import identityProvidersTable from "./identity-provider";
import llmProviderApiKeysTable from "./llm-provider-api-key";
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
const agentsTable = pgTable(
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
    /** Model ID for LLM calls */
    llmModel: text("llm_model"),

    /** Optional Identity Provider for JWKS-based JWT validation on MCP Gateway requests */
    identityProviderId: text("identity_provider_id").references(
      () => identityProvidersTable.id,
      { onDelete: "set null" },
    ),

    /** Allowlist of HTTP header names to forward from gateway requests to downstream MCP servers */
    passthroughHeaders: text("passthrough_headers").array(),

    /** Whether tools/list exposes the full tool menu or only meta-discovery tools */
    toolExposureMode: text("tool_exposure_mode")
      .$type<ToolExposureMode>()
      .notNull()
      .default("full"),

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
      .where(sql`${table.slug} IS NOT NULL`),
    index("agents_organization_id_idx").on(table.organizationId),
    index("agents_agent_type_idx").on(table.agentType),
    index("agents_identity_provider_id_idx").on(table.identityProviderId),
    index("agents_author_id_idx").on(table.authorId),
    index("agents_scope_idx").on(table.scope),
  ],
);

export default agentsTable;
