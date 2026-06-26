import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * LLM proxies a passthrough virtual key is allowed to use. An empty set means
 * the key may be used on any LLM proxy its owner can access (resolved at request
 * time). Only meaningful for `passthrough` keys.
 */
const virtualApiKeyLlmProxiesTable = pgTable(
  "virtual_api_key_llm_proxy",
  {
    virtualApiKeyId: uuid("virtual_api_key_id")
      .notNull()
      .references(() => virtualApiKeysTable.id, { onDelete: "cascade" }),
    llmProxyId: uuid("llm_proxy_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.virtualApiKeyId, table.llmProxyId] }),
    llmProxyIdIdx: index("idx_virtual_api_key_llm_proxy_llm_proxy_id").on(
      table.llmProxyId,
    ),
  }),
);

export default virtualApiKeyLlmProxiesTable;
