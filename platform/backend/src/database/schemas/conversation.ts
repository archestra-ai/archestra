import type { ChatErrorResponse, SupportedProvider } from "@shared";
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import llmProviderApiKeysTable from "./llm-provider-api-key";

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
  selectedModel: text("selected_model").notNull().default("gpt-4o"),
  selectedProvider: text("selected_provider").$type<SupportedProvider>(),
  hasCustomToolSelection: boolean("has_custom_tool_selection")
    .notNull()
    .default(false),
  todoList:
    jsonb("todo_list").$type<
      Array<{
        id: number;
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>
    >(),
  artifact: text("artifact"),
  lastChatError: jsonb("last_chat_error").$type<ChatErrorResponse>(),
  pinnedAt: timestamp("pinned_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default conversationsTable;
