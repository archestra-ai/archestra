import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import modelPoolsTable from "./model-pool";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * Virtual keys that may call a pool by its name. A pool spends its members'
 * shared provider keys, so a virtual key reaches it only when an admin adds
 * it here, the way it reaches a provider key only when it is mapped to one.
 */
const modelPoolVirtualApiKeysTable = pgTable(
  "model_pool_virtual_api_keys",
  {
    poolId: uuid("pool_id")
      .notNull()
      .references(() => modelPoolsTable.id, { onDelete: "cascade" }),
    virtualApiKeyId: uuid("virtual_api_key_id")
      .notNull()
      .references(() => virtualApiKeysTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "model_pool_virtual_api_keys_pk",
      columns: [table.poolId, table.virtualApiKeyId],
    }),
    // Backs the cascade from virtual_api_keys.
    index("model_pool_virtual_api_keys_virtual_api_key_id_idx").on(
      table.virtualApiKeyId,
    ),
  ],
);

export default modelPoolVirtualApiKeysTable;
