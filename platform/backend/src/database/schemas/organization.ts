import type {
  OrganizationCustomFont,
  OrganizationTheme,
  SupportedProvider,
} from "@shared";
import { DEFAULT_MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS } from "@shared";
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
  GlobalToolPolicy,
  OrganizationChatLink,
  OrganizationCompressionScope,
  OrganizationLimitCleanupInterval,
} from "@/types";

const organizationsTable = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  logoDark: text("logo_dark"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
  limitCleanupInterval: varchar("limit_cleanup_interval")
    .$type<OrganizationLimitCleanupInterval>()
    .default("1h"),
  onboardingComplete: boolean("onboarding_complete").notNull().default(false),
  theme: text("theme")
    .$type<OrganizationTheme>()
    .notNull()
    .default("cosmic-night"),
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
   * Whether file uploads are allowed in chat.
   * Defaults to true. Security policies currently only work on text-based content,
   * so admins may want to disable this until file-based policy support is added.
   */
  allowChatFileUploads: boolean("allow_chat_file_uploads")
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

  /** Organization-wide default LLM model ID (e.g. "gpt-4o") */
  defaultLlmModel: text("default_llm_model"),

  /** Provider for the default LLM model (e.g. "openai") */
  defaultLlmProvider: text("default_llm_provider").$type<SupportedProvider>(),

  /**
   * Chat API key used for the default LLM model.
   * FK to chat_api_keys(id) ON DELETE SET NULL — enforced by migration only (same circular issue).
   */
  defaultLlmApiKeyId: uuid("default_llm_api_key_id"),

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

  /** Chat input placeholder texts (cycles with typing animation) */
  chatPlaceholders: text("chat_placeholders").array(),

  /** Whether chat placeholders should use the typing animation */
  animateChatPlaceholders: boolean("animate_chat_placeholders")
    .notNull()
    .default(true),

  /** Square icon logo (28x28px recommended) for collapsed sidebar and chat loading indicator */
  iconLogo: text("icon_logo"),

  /** Support contact message shown in chat error cards */
  chatErrorSupportMessage: text("chat_error_support_message"),

  /** When enabled, chat shows only support text plus correlation IDs in error cards */
  slimChatErrorUi: boolean("slim_chat_error_ui").notNull().default(false),

  /** Organization-level 2FA visibility toggle */
  showTwoFactor: boolean("show_two_factor").notNull().default(false),

  /**
   * OAuth access token lifetime for MCP-native auth flows.
   * Returned to clients via `expires_in` and used to persist token expiration.
   */
  mcpOauthAccessTokenLifetimeSeconds: integer(
    "mcp_oauth_access_token_lifetime_seconds",
  )
    .notNull()
    .default(DEFAULT_MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS),
});

export default organizationsTable;
