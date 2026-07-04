import type {
  SupportedEmbeddingDimension,
  SupportedProvider,
} from "@archestra/shared";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type {
  ModelDefaultParameters,
  ModelInputModality,
  ModelOutputModality,
} from "@/types";

/**
 * Models table - stores capability and pricing metadata fetched from models.dev API.
 *
 * This table caches model information like input/output modalities, tool calling support,
 * context window size, and pricing. Data is synced periodically from models.dev.
 */
const modelsTable = pgTable(
  "models",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** External source model ID format, e.g., "anthropic/claude-3-opus" */
    externalId: text("external_id").notNull(),

    /** Archestra provider name (mapped from external source) */
    provider: text("provider").$type<SupportedProvider>().notNull(),

    /** Model ID in Archestra format (without provider prefix) */
    modelId: text("model_id").notNull(),

    /** Human-readable model description */
    description: text("description"),

    /** Maximum context window size in tokens */
    contextLength: integer("context_length"),

    /** Maximum output size in tokens (from the model source's output limit) */
    outputLength: integer("output_length"),

    /** Supported input modalities */
    inputModalities: jsonb("input_modalities").$type<ModelInputModality[]>(),

    /** Supported output modalities */
    outputModalities: jsonb("output_modalities").$type<ModelOutputModality[]>(),

    /** Whether the model supports function/tool calling */
    supportsToolCalling: boolean("supports_tool_calling"),

    /** Price per token for prompt/input (in dollars) */
    promptPricePerToken: numeric("prompt_price_per_token", {
      precision: 20,
      scale: 12,
    }),

    /** Price per token for completion/output (in dollars) */
    completionPricePerToken: numeric("completion_price_per_token", {
      precision: 20,
      scale: 12,
    }),

    /**
     * Price per token for reading a cached input token (in dollars). Synced from
     * the model registry; null when the registry omits cache pricing for this model.
     */
    cacheReadPricePerToken: numeric("cache_read_price_per_token", {
      precision: 20,
      scale: 12,
    }),

    /**
     * Price per token for writing/creating a cached input token at the default
     * (5-minute) TTL, in dollars. Synced from the model registry; null when the
     * registry omits cache pricing. Longer-TTL writes (e.g. Anthropic 1h) are
     * derived from this via a provider multiplier.
     */
    cacheWritePricePerToken: numeric("cache_write_price_per_token", {
      precision: 20,
      scale: 12,
    }),

    /** Custom admin-set price per million tokens for input (nullable, overrides models.dev price) */
    customPricePerMillionInput: numeric("custom_price_per_million_input", {
      precision: 10,
      scale: 2,
    }),

    /** Custom admin-set price per million tokens for output (nullable, overrides models.dev price) */
    customPricePerMillionOutput: numeric("custom_price_per_million_output", {
      precision: 10,
      scale: 2,
    }),

    /** Custom admin-set price per million cache-read tokens (nullable, overrides synced price) */
    customPricePerMillionCacheRead: numeric(
      "custom_price_per_million_cache_read",
      {
        precision: 10,
        scale: 2,
      },
    ),

    /** Custom admin-set price per million cache-write tokens at the default TTL (nullable, overrides synced price) */
    customPricePerMillionCacheWrite: numeric(
      "custom_price_per_million_cache_write",
      {
        precision: 10,
        scale: 2,
      },
    ),

    /** Whether this model should be excluded from chat model selection. */
    ignored: boolean("ignored").notNull().default(false),

    /**
     * Embedding dimension metadata. When non-null, the model is treated as an
     * embedding model and can be selected for knowledge base embeddings.
     */
    embeddingDimensions: integer(
      "embedding_dimensions",
    ).$type<SupportedEmbeddingDimension>(),

    /**
     * Provider-reported default generation parameters (Ollama `/api/show`).
     * Display-only metadata; nothing applies these at request time.
     */
    defaultParameters:
      jsonb("default_parameters").$type<ModelDefaultParameters>(),

    /** Whether this model was discovered via an LLM Proxy request (ensureModelExists).
     * Models with this flag are preserved even without API key links,
     * so users can define custom token pricing for metrics. */
    discoveredViaLlmProxy: boolean("discovered_via_llm_proxy")
      .notNull()
      .default(false),

    /** When this metadata was last synced from external source */
    lastSyncedAt: timestamp("last_synced_at", { mode: "date" })
      .notNull()
      .defaultNow(),

    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    /** Unique constraint on provider + model_id to prevent duplicates */
    providerModelUnique: unique("models_provider_model_unique").on(
      table.provider,
      table.modelId,
    ),
    /** Index for fast lookups by provider + model_id */
    providerModelIdx: index("models_provider_model_idx").on(
      table.provider,
      table.modelId,
    ),
    /** Index for lookups by external_id */
    externalIdIdx: index("models_external_id_idx").on(table.externalId),
  }),
);

export default modelsTable;
