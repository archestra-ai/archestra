import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelPoolsTable from "./model-pool";

/**
 * A provider key that serves its pool's model. Members are tried in ascending
 * `priority`; members that share a priority split traffic by `weight`.
 */
const modelPoolMembersTable = pgTable(
  "model_pool_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => modelPoolsTable.id, { onDelete: "cascade" }),
    providerApiKeyId: uuid("provider_api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(1),
    weight: integer("weight").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("model_pool_members_pool_key_unique").on(
      table.poolId,
      table.providerApiKeyId,
    ),
    // Backs the cascade from chat_api_keys and the proxy's member lookup.
    index("model_pool_members_provider_api_key_id_idx").on(
      table.providerApiKeyId,
    ),
  ],
);

export default modelPoolMembersTable;
