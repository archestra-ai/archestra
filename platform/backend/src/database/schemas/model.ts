import type { SupportedProvider } from "@shared";
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

import type { ModelInputModality, ModelOutputModality } from "@/types";

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
