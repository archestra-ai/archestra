import type { SupportedProvider } from "@archestra/shared";
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConversationOrigin } from "@/types/conversation";
import agentsTable from "./agent";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
import projectsTable from "./project";

// Note: Additional pg_trgm GIN index for search is created in migration 0116_pg_trgm_indexes.sql:
// - conversations_title_trgm_idx: GIN index on title column
const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  organizationId: text("organization_id").notNull(),
  // Nullable to preserve conversations when agent is deleted
  // null indicates the agent was deleted
  agentId: uuid("agent_id").references(() => agentsTable.id, {
    onDelete: "set null",
  }),
  chatApiKeyId: uuid("chat_api_key_id").references(
    () => llmProviderApiKeysTable.id,
    {
      onDelete: "set null",
    },
  ),
  title: text("title"),
  /** @deprecated Superseded by `modelId` (FK). Retained, no longer read or written. */
  selectedModel: text("selected_model").notNull().default("gpt-4o"),
  /** @deprecated Superseded by `modelId` (FK). Retained, no longer read or written. */
  selectedProvider: text("selected_provider").$type<SupportedProvider>(),
  /** FK to models(id) — the resolved model for this conversation. */
  modelId: uuid("model_id").references(() => modelsTable.id, {
    onDelete: "set null",
  }),
  hasCustomToolSelection: boolean("has_custom_tool_selection")
    .notNull()
    .default(false),
  /**
   * When true (and the viewer is an admin), hook runs in this conversation
   * surface inline as expandable debug chips. Toggled per-conversation via the
   * `/debug` chat command. See hooks/hook-run-parts.ts `stripHookRunParts`.
   */
  hooksDebugEnabled: boolean("hooks_debug_enabled").notNull().default(false),
  todoList:
    jsonb("todo_list").$type<
      Array<{
        id: number;
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>
    >(),
  artifact: text("artifact"),
  /**
   * Project this chat was started in (forever — no moves in v1). SET NULL on
   * project delete: the chat survives as an ordinary conversation.
   */
  projectId: uuid("project_id").references(() => projectsTable.id, {
    onDelete: "set null",
  }),
  /** How the chat was started; `schedule_trigger` marks a scheduled run's chat. */
  origin: text("origin").$type<ConversationOrigin>().notNull().default("user"),
  pinnedAt: timestamp("pinned_at", { mode: "date" }),
  lastMessageAt: timestamp("last_message_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  /**
   * When the owner last viewed this conversation. Drives the sidebar
   * new-messages indicator: unread = lastMessageAt > lastReadAt. Null means
   * never explicitly read (fall back to createdAt when comparing).
   */
  lastReadAt: timestamp("last_read_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default conversationsTable;
