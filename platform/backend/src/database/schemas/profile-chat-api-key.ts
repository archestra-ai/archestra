import { pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import chatApiKeysTable from "./chat-api-key";

const profileChatApiKeysTable = pgTable(
  "profile_chat_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    chatApiKeyId: uuid("chat_api_key_id")
      .notNull()
      .references(() => chatApiKeysTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Each profile can only have one API key per chat_api_key (which includes provider)
    unique("profile_chat_api_keys_agent_key_unique").on(
      table.agentId,
      table.chatApiKeyId,
    ),
  ],
);

export default profileChatApiKeysTable;
