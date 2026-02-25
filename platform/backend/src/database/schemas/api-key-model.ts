import {
  boolean,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import chatApiKeysTable from "./chat-api-key";
import modelsTable from "./model";

/**
 * Join table linking chat_api_keys to models via a many-to-many relationship.
 *
 * Models are automatically linked to API keys when:
 * 1. A new API key is created
 * 2. "Refresh models" is clicked
 *
 * Cascade delete ensures relationships are cleaned up when an API key is deleted.
 * Models themselves remain in the database even if all linked API keys are removed
 * (for metadata retention).
 */
const apiKeyModelsTable = pgTable(
  "api_key_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => chatApiKeysTable.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
    /** Whether this model is marked as the fastest (lowest latency) for this API key */
    isFastest: boolean("is_fastest").notNull().default(false),
    /** Whether this model is marked as the best (highest quality) for this API key */
    isBest: boolean("is_best").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    /** Prevent duplicate API key + model combinations */
    uniqueApiKeyModel: unique("api_key_models_unique").on(
      table.apiKeyId,
      table.modelId,
    ),
    /** Index for efficient lookups by API key */
    apiKeyIdIdx: index("api_key_models_api_key_id_idx").on(table.apiKeyId),
    /** Index for efficient lookups by model */
    modelIdIdx: index("api_key_models_model_id_idx").on(table.modelId),
  }),
);

export default apiKeyModelsTable;
