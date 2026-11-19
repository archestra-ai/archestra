import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import autoRoutersTable from "./auto-router";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * Virtual keys that may call an auto router by its name. A router spends its
 * tiers' shared provider keys, so a virtual key reaches it only when an admin
 * adds it here, the way it reaches a model pool.
 */
const autoRouterVirtualApiKeysTable = pgTable(
  "auto_router_virtual_api_keys",
  {
    routerId: uuid("router_id")
      .notNull()
      .references(() => autoRoutersTable.id, { onDelete: "cascade" }),
    virtualApiKeyId: uuid("virtual_api_key_id")
      .notNull()
      .references(() => virtualApiKeysTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "auto_router_virtual_api_keys_pk",
      columns: [table.routerId, table.virtualApiKeyId],
    }),
    // Backs the cascade from virtual_api_keys.
    index("auto_router_virtual_api_keys_virtual_api_key_id_idx").on(
      table.virtualApiKeyId,
    ),
  ],
);

export default autoRouterVirtualApiKeysTable;
