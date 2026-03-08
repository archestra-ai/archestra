import type {
  EmbeddingModel,
  OrganizationCustomFont,
  OrganizationTheme,
} from "@shared";
import {
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  GlobalToolPolicy,
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
  embeddingModel: text("embedding_model").$type<EmbeddingModel>(),

  /**
   * Chat API key used for generating embeddings (must be an OpenAI provider key).
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
});

export default organizationsTable;
