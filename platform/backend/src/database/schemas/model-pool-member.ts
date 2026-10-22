import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelPoolsTable from "./model-pool";

/**
 * One place a pool can send traffic: a provider key and the model id that
 * provider knows the pool's model by (Bedrock and Z.ai name the same model
 * differently). Members are tried in ascending `priority`; members that share
 * a priority split traffic by `weight`.
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
    /** The model id sent upstream through this member's key. */
    modelId: text("model_id").notNull(),
    priority: integer("priority").notNull().default(1),
    weight: integer("weight").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // One key can serve a pool twice under two deployments (Azure).
    unique("model_pool_members_pool_key_model_unique").on(
      table.poolId,
      table.providerApiKeyId,
      table.modelId,
    ),
    // Backs the cascade from chat_api_keys.
    index("model_pool_members_provider_api_key_id_idx").on(
      table.providerApiKeyId,
    ),
  ],
);

export default modelPoolMembersTable;
