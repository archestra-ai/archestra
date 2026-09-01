import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";
import llmProviderApiKeysTable from "./llm-provider-api-key";

/**
 * Key/value labels attached to model provider API keys.
 *
 * The primary key is (apiKeyId, key_id), so a model provider API key carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const llmProviderApiKeyLabelsTable = pgTable(
  "llm_provider_api_key_labels",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.apiKeyId, table.keyId] })],
);

export default llmProviderApiKeyLabelsTable;
