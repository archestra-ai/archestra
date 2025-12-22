import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import chatApiKeysTable from "./chat-api-key";
import promptsTable from "./prompt";

const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  organizationId: text("organization_id").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  promptId: uuid("prompt_id").references(() => promptsTable.id, {
    onDelete: "set null",
  }),
  chatApiKeyId: uuid("chat_api_key_id").references(() => chatApiKeysTable.id, {
    onDelete: "set null",
  }),
  title: text("title"),
  selectedModel: text("selected_model").notNull().default("gpt-4o"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default conversationsTable;
