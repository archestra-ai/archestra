import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AgentRuntimeAccountAuthentication } from "@/types/agent-runtime-user-account";
import agentsTable from "./agent";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
import usersTable from "./user";

/**
 * The account one person chose for their own Agent Runtime runs of one agent:
 * their personal subscription, or the company API key, with the connection
 * and the model of it that the agent and its runtime leave to each person.
 * Without a row, the person's runs use the agent's own account.
 */
const agentRuntimeUserAccountsTable = pgTable(
  "agent_runtime_user_accounts",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    authentication: text("authentication")
      .$type<AgentRuntimeAccountAuthentication>()
      .notNull(),
    // The connection a person picked for the company API key, where neither
    // the agent nor its runtime sets one. The row outlives it: their runs
    // are refused until they choose again, and never move to another
    // connection on their own.
    llmApiKeyId: uuid("llm_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      { onDelete: "set null" },
    ),
    // The model a person picked: of their subscription, or of the company
    // API key's connection. The row outlives it, and their runs are refused
    // until they choose again.
    modelId: uuid("model_id").references(() => modelsTable.id, {
      onDelete: "set null",
    }),
    // Whether the person picked a connection, and a model. Deleting one
    // empties its column, so only these tell a deleted pick from a part
    // the person never picked.
    llmApiKeyChosen: boolean("llm_api_key_chosen").notNull().default(false),
    modelChosen: boolean("model_chosen").notNull().default(false),
    // The model of a person's own Claude subscription, as Claude Code names
    // it: an alias such as "opus", not a catalog row.
    claudeModel: text("claude_model"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.userId] }),
    check(
      "agent_runtime_user_accounts_authentication_check",
      sql`${table.authentication} in ('provider', 'subscription')`,
    ),
    // A stored id is always one the person picked.
    check(
      "agent_runtime_user_accounts_chosen_check",
      sql`(${table.llmApiKeyId} is null or ${table.llmApiKeyChosen}) and (${table.modelId} is null or ${table.modelChosen})`,
    ),
    // Back the FK cascades; the PK starts with agent_id.
    index("agent_runtime_user_accounts_user_id_idx").on(table.userId),
    index("agent_runtime_user_accounts_llm_api_key_id_idx").on(
      table.llmApiKeyId,
    ),
    index("agent_runtime_user_accounts_model_id_idx").on(table.modelId),
  ],
);

export default agentRuntimeUserAccountsTable;
