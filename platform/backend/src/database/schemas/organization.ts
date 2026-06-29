import type {
  OrganizationCustomFont,
  OrganizationTheme,
  SupportedProvider,
} from "@archestra/shared";
import { DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS } from "@archestra/shared";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ConnectionBaseUrl,
  ConnectionDefaultProviderKeys,
  DiscoveredToolPolicy,
  GlobalToolPolicy,
  LimitCleanupInterval,
  NetworkPolicy,
  OnboardingWizard,
  OrganizationChatLink,
  OrganizationCompressionScope,
} from "@/types";
import modelsTable from "./model";

const organizationsTable = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  analyticsInstanceId: uuid("analytics_instance_id").notNull().defaultRandom(),
  analyticsInstanceStartedAt: timestamp("analytics_instance_started_at"),
  analyticsInstanceLastHeartbeatAt: timestamp(
    "analytics_instance_last_heartbeat_at",
  ),
  logo: text("logo"),
  logoDark: text("logo_dark"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
  onboardingComplete: boolean("onboarding_complete").notNull().default(false),
  theme: text("theme").$type<OrganizationTheme>().notNull().default("caffeine"),
  customFont: text("custom_font")
    .$type<OrganizationCustomFont>()
    .notNull()
    .default("lato"),
  convertToolResultsToToon: boolean("convert_tool_results_to_toon")
    .notNull()
    .default(true),
  compressionScope: varchar("compression_scope")
    .$type<OrganizationCompressionScope>()
    .notNull()
    .default("organization"),
  globalToolPolicy: varchar("global_tool_policy")
    .$type<GlobalToolPolicy>()
    .notNull()
    .default("permissive"),
  /**
   * Policy for tools auto-discovered via the LLM proxy. Resolved independently
   * of globalToolPolicy so a restrictive global posture does not block tools
   * Claude Code / Claude Desktop discover by default. Defaults to "relaxed".
   */
  discoveredToolPolicy: varchar("discovered_tool_policy")
    .$type<DiscoveredToolPolicy>()
    .notNull()
    .default("relaxed"),
  /**
   * Whether file uploads are allowed in chat.
   * Defaults to true. Security policies currently only work on text-based content,
   * so admins may want to disable this until file-based policy support is added.
   */
  allowChatFileUploads: boolean("allow_chat_file_uploads")
    .notNull()
    .default(true),

  /**
   * @deprecated No longer consulted. Dynamic tool access is now gated solely
   * by the per-agent `access_all_tools` setting. The column is retained (not
   * dropped) to avoid a backwards-incompatible migration and to keep the
   * existing API field; any stored value is ignored. Safe to drop in a future
   * migration once no deployment reads it.
   */
  allowToolAutoAssignment: boolean("allow_tool_auto_assignment")
    .notNull()
    .default(true),

  /** Embedding model for knowledge base RAG — set explicitly when user configures embedding */
  embeddingModel: text("embedding_model"),

  /**
   * @deprecated temporary transition field while embedding dimensions move to `models.embeddingDimensions`.
   *
   * TODO: Remove references and drop this column in a future release after existing org configs have been migrated.
   */
  embeddingDimensions: integer("embedding_dimensions"),

  /**
   * Chat API key used for generating embeddings.
   * FK to chat_api_keys(id) ON DELETE SET NULL — enforced by migration only
   * (Drizzle .references() causes TS circular inference: organization → chat-api-key → team → organization).
   */
  embeddingChatApiKeyId: uuid("embedding_chat_api_key_id"),

  /**
   * Chat API key used for reranking search results.
   * FK to chat_api_keys(id) ON DELETE SET NULL — enforced by migration only (same circular issue).
   */
  rerankerChatApiKeyId: uuid("reranker_chat_api_key_id"),

  /** LLM model used for reranking (e.g. "gpt-4o") */
  rerankerModel: text("reranker_model"),

  /** @deprecated Superseded by `defaultModelId` (FK). Retained, no longer read or written. */
  defaultLlmModel: text("default_llm_model"),
  /** @deprecated Superseded by `defaultModelId` (FK). Retained, no longer read or written. */
  defaultLlmProvider: text("default_llm_provider").$type<SupportedProvider>(),

  /** Organization-wide default model. FK to models(id) ON DELETE SET NULL. */
  defaultModelId: uuid("default_model_id").references(() => modelsTable.id, {
    onDelete: "set null",
  }),

  /**
   * Chat API key used for the default LLM model.
   * FK to chat_api_keys(id) ON DELETE SET NULL — enforced by migration only (same circular issue).
   */
  defaultLlmApiKeyId: uuid("default_llm_api_key_id"),

  /** Default token-cost limit value applied to every organization member. */
  defaultUserLimitValue: integer("default_user_limit_value"),

  /** Models covered by the default user limit. Null means all models. */
  defaultUserLimitModel: jsonb("default_user_limit_model").$type<
    string[] | null
  >(),

  /** Cleanup interval used by default user limits. Null falls back to weekly. */
  defaultUserLimitCleanupInterval: varchar(
    "default_user_limit_cleanup_interval",
  ).$type<LimitCleanupInterval>(),

  /**
   * Organization-wide default agent ID (fallback when member has no personal default).
   * FK to agents(id) ON DELETE SET NULL — enforced by migration only
   * (Drizzle .references() causes TS circular inference: organization → agent → ... → organization).
   */
  defaultAgentId: uuid("default_agent_id"),

  /** Custom favicon (base64 PNG, same validation as logo) */
  favicon: text("favicon"),

  /** Custom browser tab title */
  appName: text("app_name"),

  /** OpenGraph description for link previews */
  ogDescription: text("og_description"),

  /** Custom footer text (replaces version display) */
  footerText: text("footer_text"),

  /** Optional quick links shown on the new chat page */
  chatLinks: jsonb("chat_links").$type<OrganizationChatLink[]>(),

  /** Optional multi-step onboarding wizard rendered beside chat links on the new chat page */
  onboardingWizard: jsonb("onboarding_wizard").$type<OnboardingWizard>(),

  /** Chat input placeholder texts (cycles with typing animation) */
  chatPlaceholders: text("chat_placeholders").array(),

  /** Whether chat placeholders should use the typing animation */
  animateChatPlaceholders: boolean("animate_chat_placeholders")
    .notNull()
    .default(true),

  /** Square icon logo (28x28px recommended) for collapsed sidebar and chat loading indicator. PNG or SVG. */
  iconLogo: text("icon_logo"),

  /** Dark-mode variant of the icon logo. Falls back to `iconLogo` when not set. */
  iconLogoDark: text("icon_logo_dark"),

  /** Support contact message shown in chat error cards */
  chatErrorSupportMessage: text("chat_error_support_message"),

  /** When enabled, chat shows only support text plus correlation IDs in error cards */
  slimChatErrorUi: boolean("slim_chat_error_ui").notNull().default(false),

  /** Organization-level 2FA visibility toggle */
  showTwoFactor: boolean("show_two_factor").notNull().default(false),

  /**
   * Organization OAuth access token lifetime for user authorization-code flows.
   * Returned to clients via `expires_in` and used to persist token expiration.
   */
  oauthAccessTokenLifetimeSeconds: integer(
    "oauth_access_token_lifetime_seconds",
  )
    .notNull()
    .default(DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS),

  /**
   * Admin-selected MCP gateway pre-filled on /connection.
   * FK to agents(id) ON DELETE SET NULL — enforced by migration only
   * (same circular-inference issue as defaultAgentId).
   */
  connectionDefaultMcpGatewayId: uuid("connection_default_mcp_gateway_id"),

  /**
   * Admin-selected LLM proxy pre-filled on /connection.
   * FK to agents(id) ON DELETE SET NULL — enforced by migration only.
   */
  connectionDefaultLlmProxyId: uuid("connection_default_llm_proxy_id"),

  /**
   * Admin-selected client pre-selected on /connection. Null falls back to the
   * system default ("generic" / "Any Client"). Stored as a string because
   * client IDs are a frontend-owned string enum, not a DB row.
   */
  connectionDefaultClientId: text("connection_default_client_id"),

  /**
   * Client IDs shown on the /connection client grid. Null = show all.
   * ("generic" is always shown regardless of this list.)
   */
  connectionShownClientIds: text("connection_shown_client_ids").array(),

  /** Providers shown in the /connection proxy step. Null = show all. */
  connectionShownProviders: text("connection_shown_providers")
    .$type<SupportedProvider[]>()
    .array(),

  /**
   * Per-URL metadata (description + default flag) for the externally configured
   * proxy URLs (NEXT_PUBLIC_ARCHESTRA_API_BASE_URL). The URLs themselves are
   * still env-driven — this table just augments them with admin context.
   */
  connectionBaseUrls: jsonb("connection_base_urls").$type<
    ConnectionBaseUrl[]
  >(),

  /**
   * Admin-chosen provider API key per provider for auto-provisioned
   * connection virtual keys (provider → llm_provider_api_keys.id). When a
   * provider has no entry, provisioning falls back to the user's
   * personal → team → org key resolution.
   */
  connectionDefaultProviderKeys: jsonb(
    "connection_default_provider_keys",
  ).$type<ConnectionDefaultProviderKeys>(),

  /**
   * Legacy preset columns (feature removed) — retained inert (non-destructive,
   * no migration) and no longer read or written. Held admin-chosen singular/
   * plural labels that the catalog UI used to override "Preset"/"presets" copy.
   */
  presetEntityName: text("preset_entity_name"),
  presetEntityNamePlural: text("preset_entity_name_plural"),

  /**
   * Legacy preset column (feature removed) — retained inert. Held the custom
   * display label for the implicit "default" preset row. No longer read or
   * written.
   */
  presetEntityDefaultLabel: text("preset_entity_default_label"),

  /**
   * Display name of the implicit "default" environment (the deployment target
   * referenced by internal_mcp_catalog.environment_id = null). NULL falls back
   * to "Default" in the UI.
   */
  defaultEnvironmentName: text("default_environment_name"),

  /**
   * Kubernetes namespace for the implicit "default" environment. Stored only
   * (not applied at deploy yet). NULL = unset.
   */
  defaultEnvironmentNamespace: text("default_environment_namespace"),

  /**
   * Optional human-readable description of the implicit "default" environment,
   * shown in the environment selector. NULL = unset.
   */
  defaultEnvironmentDescription: text("default_environment_description"),

  /**
   * Optional default network egress policy for the implicit "default"
   * environment. NULL falls back to built-in unrestricted behavior.
   */
  defaultNetworkPolicy: jsonb("default_network_policy").$type<NetworkPolicy>(),

  /**
   * When true, assigning a catalog item to the implicit "default" environment
   * (environment_id = null) requires the `environment:admin` permission — i.e.
   * creating a catalog item without choosing an environment is admin-gated.
   * Mirrors the per-environment `environment.restricted` flag for the default.
   */
  defaultEnvironmentRestricted: boolean("default_environment_restricted")
    .notNull()
    .default(false),

  /**
   * ALLOWLIST regex (JS source, no delimiters/flags) for the implicit "default"
   * environment (internal_mcp_catalog.environment_id = null). User-supplied
   * config values are allowed only if they MATCH. NULL disables. Mirrors
   * `environment.validation_regex` for the default scope.
   */
  defaultEnvironmentValidationRegex: text(
    "default_environment_validation_regex",
  ),

  /**
   * When true, the Agent Skill tools (`list_skills`, `load_skill`) are assigned
   * to every agent in the org and added to all new agents. Flipped on
   * by the "Enable and create a new skill" empty-state button on /skills.
   */
  skillToolsEnabled: boolean("skill_tools_enabled").notNull().default(false),

  /**
   * When true, the org's skills are exposed in chat as slash commands
   * (`/skill-name`). Invoking one injects the skill's content directly into the
   * conversation, independent of `skillToolsEnabled` (which only governs the
   * model-facing `load_skill` tool).
   */
  skillSlashCommandsEnabled: boolean("skill_slash_commands_enabled")
    .notNull()
    .default(false),

  /**
   * Legacy preset column (feature removed) — retained inert. Held a validation
   * regex (no delimiters/flags) applied to default-scoped field values at
   * install time. No longer read or written.
   */
  presetEntityDefaultValidationRegex: text(
    "preset_entity_default_validation_regex",
  ),
});

export default organizationsTable;
