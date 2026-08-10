import {
  boolean,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import llmProviderApiKeysTable from "./llm-provider-api-key";
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
const llmProviderApiKeyModelsTable = pgTable(
  "api_key_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
    /** Whether this model is marked as the best (highest quality) for this API key */
    isBest: boolean("is_best").notNull().default(false),
    /**
     * Whether this model is worth pointing an agent at, as judged from what
     * THIS key's endpoint serves. Tri-state: an explicit `false` is a claim
     * backed by evidence, `true` means the evidence says the model is fine, and
     * null means the sync learned nothing (every provider but Ollama). Only
     * `false` is ever surfaced — `true` cannot distinguish "known good" from
     * "no evidence", so it stays silent.
     *
     * Lives on the link, not on `models`: an Ollama tag is endpoint-local
     * (`custom:latest` can name a 4B build on one server and a 70B build on
     * another), so a verdict written to the globally unique (provider,
     * model_id) row would let whichever endpoint synced last speak for all of
     * them. Today the only evidence is Ollama's parameter count (`/api/show`,
     * GGUF `general.parameter_count`) against `SMALL_MODEL_MAX_PARAMETERS`;
     * every other provider reports nothing usable, vLLM included — its
     * OpenAI-compatible `ModelCard` carries no size field and there is no
     * second endpoint to ask.
     *
     * Nullable because `/api/show` is time-boxed and degrades to null per
     * model, so the sync needs a value that means "no evidence this round" and
     * can be COALESCEd away instead of silently un-flagging a 4B model.
     */
    recommendedForAgents: boolean("recommended_for_agents"),
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

export default llmProviderApiKeyModelsTable;
