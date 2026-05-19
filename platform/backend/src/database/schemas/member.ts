import { MEMBER_ROLE_NAME } from "@shared";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
import organizationsTable from "./organization";
import usersTable from "./user";

const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Role identifier e.g. "member" (buit-in) or "reader" (custom)
    // It's because better-auth references the roles by identifiers not uuids.
    role: text("role").default(MEMBER_ROLE_NAME).notNull(),
    createdAt: timestamp("created_at").notNull(),
    defaultAgentId: uuid("default_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    /** Per-member default model. FK to models(id) ON DELETE SET NULL. */
    defaultModelId: uuid("default_model_id").references(() => modelsTable.id, {
      onDelete: "set null",
    }),
    /** Per-member default chat API key. FK to chat_api_keys(id) ON DELETE SET NULL. */
    defaultChatApiKeyId: uuid("default_chat_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      { onDelete: "set null" },
    ),
  },
  (table) => ({
    userOrganizationIdx: index("member_user_id_organization_id_idx").on(
      table.userId,
      table.organizationId,
    ),
  }),
);

export default member;
