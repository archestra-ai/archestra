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
 * DEPRECATED / ORPHANED — retained only for a zero-downtime rolling deploy.
 *
 * This table previously held the per-passthrough-key "allowed LLM proxies"
 * allow-list. That feature has been removed: passthrough virtual keys now only
 * authenticate the acting user, and LLM proxy access is governed by the user's
 * own access permissions. NO application code reads, writes, or references this
 * table anymore. This declaration exists solely so Drizzle keeps the table in
 * the schema snapshot and does NOT generate a DROP migration during the release
 * that ships the code removal — dropping it now would break old pods still
 * running during the rollout.
 *
 * TODO(phase-2): in a follow-up release, once the code-removal release is fully
 * rolled out, delete this file and its `index.ts` export and generate the DROP
 * migration for `virtual_api_key_llm_proxy`.
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
