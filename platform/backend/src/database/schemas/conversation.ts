import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { SupportedChatProvider } from "@/types";
import agentsTable from "./agent";
import chatApiKeysTable from "./chat-api-key";

// Note: Additional pg_trgm GIN index for search is created in migration 0116_pg_trgm_indexes.sql:
// - conversations_title_trgm_idx: GIN index on title column
const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  organizationId: text("organization_id").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  chatApiKeyId: uuid("chat_api_key_id").references(() => chatApiKeysTable.id, {
    onDelete: "set null",
  }),
  title: text("title"),
  selectedModel: text("selected_model").notNull().default("gpt-4o"),
  selectedProvider: text("selected_provider").$type<SupportedChatProvider>(),
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
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default conversationsTable;
