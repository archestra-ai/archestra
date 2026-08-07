import {
  CACHE_PRICE_MULTIPLIERS,
  PROVIDERS_BILLING_NO_TOKEN_RATE,
  type SupportedProvider,
} from "@archestra/shared";
import {
  and,
  count,
  eq,
  ilike,
  inArray,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { sanitizeOutputLimit } from "@/clients/models-dev-client";
import db, { schema, withDbTransaction } from "@/database";
import logger from "@/logging";
import { resolveBedrockAwsPrices } from "@/services/bedrock-aws-pricing";
import type {
  CreateModel,
  Model,
  ModelCapabilities,
  ModelDefaultParameters,
  PatchModelBody,
  PriceSource,
} from "@/types";
import ModelTeamModel from "./model-team";

/**
 * Effective pricing result with source tracking. All prices are per-million
 * tokens as decimal strings. Cache prices are null when the model's provider has
 * no cache pricing model (neither explicit nor multiplier-derivable).
 */
interface EffectivePricing {
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
  source: PriceSource;
  /** Cache-read price per million tokens, or null when unpriced. */
  pricePerMillionCacheRead: string | null;
  /** Cache-write price per million tokens at the default (5m) TTL, or null when unpriced. */
  pricePerMillionCacheWrite: string | null;
  /** Source of the cache price, or null when unpriced. */
  cacheSource: PriceSource | null;
}

/**
 * Returns default token prices for a model.
 * Cheaper models (-haiku, -nano, -mini) get $30/million tokens.
 * All other models get $50/million tokens.
 *
 * Why this approach?
 * 1. We autodetect the model from the interaction. Setting the default to $50 helps signal
 *    that the value should be updated later with the correct pricing.
 * 2. Companies may have custom pricing. If we used the “official” model prices here,
 *    it would be harder to notice when the pricing is incorrect.
 * 3. Smaller models may be used in Optimization Rules. Even if pricing isn’t configured,
 *    we still want to surface potential cost savings.
 */
function getDefaultModelPrice(model: string): {
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
} {
  const cheaperPatterns = ["-haiku", "-nano", "-mini"];
  const isCheaper = cheaperPatterns.some((pattern) =>
    model.toLowerCase().includes(pattern),
  );

  const price = isCheaper ? "30.00" : "50.00";
  return {
    pricePerMillionInput: price,
    pricePerMillionOutput: price,
  };
}

/**
 * Resolve one cache direction (read or write) with per-field precedence:
 * custom override → registry-synced → multiplier-derived from the input price.
 * Returns a null price + null source when none of those apply.
 */
function resolveCacheDirection(params: {
  custom: string | null | undefined;
  syncedPerToken: string | null | undefined;
  multiplierFactor: number | undefined;
  effectivePricePerMillionInput: number;
}): { price: string | null; source: PriceSource | null } {
  const {
    custom,
    syncedPerToken,
    multiplierFactor,
    effectivePricePerMillionInput,
  } = params;
  if (custom != null) {
    return { price: custom, source: "custom" };
  }
  if (syncedPerToken != null) {
    return {
      price: formatPerMillionPrice(
        Number.parseFloat(syncedPerToken) * 1_000_000,
      ),
      source: "models_dev",
    };
  }
  if (multiplierFactor !== undefined) {
    return {
      price: formatPerMillionPrice(
        effectivePricePerMillionInput * multiplierFactor,
      ),
      source: "derived_multiplier",
    };
  }
  return { price: null, source: null };
}

/**
 * Collapse the read/write cache-price sources into one label for display,
 * favouring the most authoritative direction: custom → models.dev → derived.
 *
 * It reads `derived_multiplier` (the "estimated" signal) only when BOTH
 * directions are derived. This matters because providers that don't charge for
 * cache writes (OpenAI/Gemini/DeepSeek) always derive a structurally-zero write;
 * that known-zero must not make a model with a real synced cache-read price
 * appear estimated. (Synced-read + non-zero-derived-write does not occur in
 * practice — the providers with a non-zero write surcharge publish both prices.)
 */
function combineCacheSource(
  readSource: PriceSource | null,
  writeSource: PriceSource | null,
): PriceSource {
  const sources = [readSource, writeSource].filter(
    (s): s is PriceSource => s != null,
  );
  if (sources.includes("custom")) return "custom";
  if (sources.includes("models_dev")) return "models_dev";
  return "derived_multiplier";
}

/**
 * Format a per-million price as a precise, trailing-zero-free string.
 *
 * Callers compute cost by parsing this back, so rounding it to the cent quietly
 * becomes a billing error: $0.035/M reads as $0.04, a 14% overstatement, and
 * anything under $0.005/M reads as free. Padding for display is the reading
 * end's job.
 */
function formatPerMillionPrice(perMillion: number): string {
  return Number.parseFloat(perMillion.toFixed(8)).toString();
}

/**
 * Read the Modelfile `num_ctx` out of the provider-reported defaults.
 *
 * `defaultParameters` is parsed from Ollama's free-form `parameters` text block,
 * so the value arrives as a string as often as a number, and an unrecognised
 * block can put anything here. Coerce narrowly and let the caller's
 * `sanitizeOutputLimit` reject whatever is left — this feeds the context ring
 * and the compaction threshold, so a bad parse must fall back rather than
 * propagate.
 */
function readOllamaDefaultNumCtx(
  defaultParameters: ModelDefaultParameters | null | undefined,
): number | null {
  // A Modelfile may set the same PARAMETER twice, which the fetcher collects
  // into an array. Ollama itself is last-wins, so take the final entry rather
  // than rejecting the whole value and falling back to the architectural
  // window — that fallback is the very overstatement this resolution exists
  // to prevent.
  const collected = defaultParameters?.num_ctx;
  const raw = Array.isArray(collected) ? collected.at(-1) : collected;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

class ModelModel {
  /**
   * Find all models discovered via LLM Proxy requests.
   */
  static async findLlmProxyModels(): Promise<Model[]> {
    return await db
      .select()
      .from(schema.modelsTable)
      .where(eq(schema.modelsTable.discoveredViaLlmProxy, true));
  }

  static async findAll(params?: {
    search?: string;
    provider?: SupportedProvider;
    providers?: SupportedProvider[];
  }): Promise<Model[]> {
    const conditions = [];

    if (params?.search) {
      conditions.push(ilike(schema.modelsTable.modelId, `%${params.search}%`));
    }
    if (params?.provider) {
      conditions.push(eq(schema.modelsTable.provider, params.provider));
    }
    if (params?.providers) {
      if (params.providers.length === 0) {
        return [];
      }
      conditions.push(inArray(schema.modelsTable.provider, params.providers));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return await db.select().from(schema.modelsTable).where(whereClause);
  }

  /**
   * Find model by its internal UUID
   */
  static async findById(id: string): Promise<Model | null> {
    const [result] = await db
      .select()
      .from(schema.modelsTable)
      .where(eq(schema.modelsTable.id, id));

    return result || null;
  }

  /**
   * Find model by provider and model ID
   */
  static async findByProviderAndModelId(
    provider: SupportedProvider,
    modelId: string,
  ): Promise<Model | null> {
    const [result] = await db
      .select()
      .from(schema.modelsTable)
      .where(
        and(
          eq(schema.modelsTable.provider, provider),
          eq(schema.modelsTable.modelId, modelId),
        ),
      );

    return result || null;
  }

  /**
   * Find models for multiple provider:modelId combinations
   */
  static async findByProviderModelIds(
    keys: Array<{ provider: SupportedProvider; modelId: string }>,
  ): Promise<Map<string, Model>> {
    if (keys.length === 0) {
      return new Map();
    }

    // Build OR conditions to filter at database level
    const conditions = keys.map((key) =>
      and(
        eq(schema.modelsTable.provider, key.provider),
        eq(schema.modelsTable.modelId, key.modelId),
      ),
    );

    const results = await db
      .select()
      .from(schema.modelsTable)
      .where(or(...conditions));

    const map = new Map<string, Model>();
    for (const result of results) {
      const key = `${result.provider}:${result.modelId}`;
      map.set(key, result);
    }

    return map;
  }

  /**
   * Find text chat models by exact model ID across providers.
   * Used by the OpenAI-compatible model router to resolve a client-supplied
   * model name to the provider that owns it.
   */
  static async findTextChatModelsByModelId(params: {
    modelId: string;
    provider?: SupportedProvider;
  }): Promise<Model[]> {
    const conditions = [eq(schema.modelsTable.modelId, params.modelId)];

    if (params.provider) {
      conditions.push(eq(schema.modelsTable.provider, params.provider));
    }

    const results = await db
      .select()
      .from(schema.modelsTable)
      .where(and(...conditions));

    return results.filter((model) => ModelModel.supportsTextChat(model));
  }

  /**
   * Find embedding models by exact model ID across providers.
   */
  static async findEmbeddingModelsByModelId(params: {
    modelId: string;
    provider?: SupportedProvider;
  }): Promise<Model[]> {
    const conditions = [eq(schema.modelsTable.modelId, params.modelId)];

    if (params.provider) {
      conditions.push(eq(schema.modelsTable.provider, params.provider));
    }

    const results = await db
      .select()
      .from(schema.modelsTable)
      .where(and(...conditions));

    return results.filter((model) => ModelModel.supportsEmbeddings(model));
  }

  /**
   * Create new model
   */
  static async create(data: CreateModel): Promise<Model> {
    const [result] = await db
      .insert(schema.modelsTable)
      .values(data)
      .returning();

    return result;
  }

  /**
   * Upsert model by provider and model ID.
   * Does NOT overwrite customPricePerMillionInput/Output on conflict.
   */
  static async upsert(data: CreateModel): Promise<Model> {
    const [result] = await db
      .insert(schema.modelsTable)
      .values(data)
      .onConflictDoUpdate({
        target: [schema.modelsTable.provider, schema.modelsTable.modelId],
        set: {
          externalId: data.externalId,
          description: data.description,
          contextLength: sql`COALESCE(${schema.modelsTable.contextLength}, excluded.context_length)`,
          // Unlike the other capability fields, outputLength has no admin editor
          // and is used as an output-token safety cap, so prefer the freshly
          // synced value (keeping the last known value only when the sync omits it)
          // — a lowered provider cap must propagate, not be pinned forever.
          outputLength: sql`COALESCE(excluded.output_length, ${schema.modelsTable.outputLength})`,
          inputModalities: sql`COALESCE(${schema.modelsTable.inputModalities}, excluded.input_modalities)`,
          outputModalities: sql`COALESCE(${schema.modelsTable.outputModalities}, excluded.output_modalities)`,
          supportsToolCalling: sql`COALESCE(${schema.modelsTable.supportsToolCalling}, excluded.supports_tool_calling)`,
          promptPricePerToken: data.promptPricePerToken,
          completionPricePerToken: data.completionPricePerToken,
          cacheReadPricePerToken: data.cacheReadPricePerToken,
          cacheWritePricePerToken: data.cacheWritePricePerToken,
          embeddingDimensions: sql`COALESCE(${schema.modelsTable.embeddingDimensions}, excluded.embedding_dimensions)`,
          // Display-only provider metadata (not user-editable): prefer the fresh
          // synced value so changed Ollama defaults show up, keeping the last
          // known value only when a sync omits it (e.g. a transient /api/show miss).
          defaultParameters: sql`COALESCE(excluded.default_parameters, ${schema.modelsTable.defaultParameters})`,
          // Same treatment as defaultParameters: `/api/show` is best-effort
          // (time-boxed, degrades to null per model), so a transient miss must
          // not wipe a known size.
          parameterCount: sql`COALESCE(excluded.parameter_count, ${schema.modelsTable.parameterCount})`,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
          // NOTE: custom price overrides (input/output/cache) intentionally NOT updated
          // NOTE: capability fields only backfill when the existing DB value is null
          // to preserve user-edited values while still populating missing metadata
        },
      })
      .returning();

    return result;
  }

  /**
   * Bulk upsert models.
   * Uses batched inserts with ON CONFLICT to avoid query parameter limits.
   * PostgreSQL has a 65535 parameter limit, so we batch to stay well under.
   * All batches are wrapped in a transaction to ensure atomicity.
   * NOTE: Does NOT overwrite customPricePerMillionInput/Output on conflict.
   */
  static async bulkUpsert(dataArray: CreateModel[]): Promise<Model[]> {
    if (dataArray.length === 0) {
      return [];
    }

    // Batch size of 50 rows to stay safely under PostgreSQL parameter limits
    // Each row has ~11 columns, so 50 rows = ~550 parameters per batch
    const BATCH_SIZE = 50;
    const totalBatches = Math.ceil(dataArray.length / BATCH_SIZE);

    logger.debug(
      { totalModels: dataArray.length, batchSize: BATCH_SIZE, totalBatches },
      "Starting batched model upsert",
    );

    // Wrap all batches in a transaction to ensure atomicity
    const results = await withDbTransaction(async (tx) => {
      const batchResults: Model[] = [];

      for (let i = 0; i < dataArray.length; i += BATCH_SIZE) {
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
        const batch = dataArray.slice(i, i + BATCH_SIZE);

        logger.debug(
          { batchNumber, totalBatches, batchSize: batch.length },
          "Processing model batch",
        );

        const insertedBatch = await tx
          .insert(schema.modelsTable)
          .values(batch)
          .onConflictDoUpdate({
            target: [schema.modelsTable.provider, schema.modelsTable.modelId],
            set: {
              externalId: sql`excluded.external_id`,
              description: sql`excluded.description`,
              contextLength: sql`COALESCE(${schema.modelsTable.contextLength}, excluded.context_length)`,
              // See upsert(): outputLength prefers the fresh synced value so a
              // lowered provider cap propagates instead of being pinned forever.
              outputLength: sql`COALESCE(excluded.output_length, ${schema.modelsTable.outputLength})`,
              inputModalities: sql`COALESCE(${schema.modelsTable.inputModalities}, excluded.input_modalities)`,
              outputModalities: sql`COALESCE(${schema.modelsTable.outputModalities}, excluded.output_modalities)`,
              supportsToolCalling: sql`COALESCE(${schema.modelsTable.supportsToolCalling}, excluded.supports_tool_calling)`,
              promptPricePerToken: sql`excluded.prompt_price_per_token`,
              completionPricePerToken: sql`excluded.completion_price_per_token`,
              cacheReadPricePerToken: sql`excluded.cache_read_price_per_token`,
              cacheWritePricePerToken: sql`excluded.cache_write_price_per_token`,
              embeddingDimensions: sql`COALESCE(${schema.modelsTable.embeddingDimensions}, excluded.embedding_dimensions)`,
              // Display-only provider metadata (not user-editable): prefer the
              // fresh synced value so changed Ollama defaults show up, keeping
              // the last known value only when a sync omits it.
              defaultParameters: sql`COALESCE(excluded.default_parameters, ${schema.modelsTable.defaultParameters})`,
              // See upsert(): a time-boxed /api/show miss must not wipe a known size.
              parameterCount: sql`COALESCE(excluded.parameter_count, ${schema.modelsTable.parameterCount})`,
              lastSyncedAt: sql`excluded.last_synced_at`,
              updatedAt: sql`NOW()`,
              // NOTE: custom price overrides (input/output/cache) intentionally NOT updated
              // NOTE: capability fields only backfill when the existing DB value is null
              // to preserve user-edited values while still populating missing metadata
            },
          })
          .returning();

        batchResults.push(...insertedBatch);
      }

      return batchResults;
    });

    logger.info(
      { totalUpserted: results.length },
      "Completed batched model upsert",
    );

    return results;
  }

  /**
   * Bulk upsert models, overwriting ALL fields including user-edited values.
   * Used by the "full refresh" flow to reset models to provider defaults.
   */
  static async bulkUpsertFull(dataArray: CreateModel[]): Promise<Model[]> {
    if (dataArray.length === 0) {
      return [];
    }

    const BATCH_SIZE = 50;
    const totalBatches = Math.ceil(dataArray.length / BATCH_SIZE);

    logger.debug(
      { totalModels: dataArray.length, batchSize: BATCH_SIZE, totalBatches },
      "Starting batched full model upsert",
    );

    const results = await withDbTransaction(async (tx) => {
      const batchResults: Model[] = [];

      for (let i = 0; i < dataArray.length; i += BATCH_SIZE) {
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
        const batch = dataArray.slice(i, i + BATCH_SIZE);

        logger.debug(
          { batchNumber, totalBatches, batchSize: batch.length },
          "Processing full model batch",
        );

        const insertedBatch = await tx
          .insert(schema.modelsTable)
          .values(batch)
          .onConflictDoUpdate({
            target: [schema.modelsTable.provider, schema.modelsTable.modelId],
            set: {
              externalId: sql`excluded.external_id`,
              description: sql`excluded.description`,
              contextLength: sql`excluded.context_length`,
              outputLength: sql`excluded.output_length`,
              inputModalities: sql`excluded.input_modalities`,
              outputModalities: sql`excluded.output_modalities`,
              supportsToolCalling: sql`excluded.supports_tool_calling`,
              promptPricePerToken: sql`excluded.prompt_price_per_token`,
              completionPricePerToken: sql`excluded.completion_price_per_token`,
              cacheReadPricePerToken: sql`excluded.cache_read_price_per_token`,
              cacheWritePricePerToken: sql`excluded.cache_write_price_per_token`,
              embeddingDimensions: sql`excluded.embedding_dimensions`,
              defaultParameters: sql`excluded.default_parameters`,
              // Plain `excluded`, unlike the COALESCE in bulkUpsert: an Ollama
              // tag is mutable (`ollama create` can repoint it), so a full
              // refresh has to stay the way to correct a stale size.
              parameterCount: sql`excluded.parameter_count`,
              customPricePerMillionInput: sql`NULL`,
              customPricePerMillionOutput: sql`NULL`,
              customPricePerMillionCacheRead: sql`NULL`,
              customPricePerMillionCacheWrite: sql`NULL`,
              lastSyncedAt: sql`excluded.last_synced_at`,
              updatedAt: sql`NOW()`,
            },
          })
          .returning();

        batchResults.push(...insertedBatch);
      }

      return batchResults;
    });

    logger.info(
      { totalUpserted: results.length },
      "Completed batched full model upsert",
    );

    return results;
  }

  /**
   * Delete model by provider and model ID
   */
  static async delete(
    provider: SupportedProvider,
    modelId: string,
  ): Promise<boolean> {
    // First check if the record exists (PGLite doesn't return rowCount reliably)
    const existing = await ModelModel.findByProviderAndModelId(
      provider,
      modelId,
    );
    if (!existing) {
      return false;
    }

    await db
      .delete(schema.modelsTable)
      .where(
        and(
          eq(schema.modelsTable.provider, provider),
          eq(schema.modelsTable.modelId, modelId),
        ),
      );

    return true;
  }

  /**
   * Delete all models
   */
  static async deleteAll(): Promise<void> {
    await db.delete(schema.modelsTable);
  }

  /**
   * Delete orphaned models that have no API key links and were NOT
   * discovered via LLM Proxy. LLM Proxy models are preserved so users
   * can define custom token pricing for metrics.
   */
  static async deleteOrphanedModels(): Promise<number> {
    const orphaned = await db
      .delete(schema.modelsTable)
      .where(
        and(
          eq(schema.modelsTable.discoveredViaLlmProxy, false),
          notInArray(
            schema.modelsTable.id,
            db
              .selectDistinct({
                modelId: schema.llmProviderApiKeyModelsTable.modelId,
              })
              .from(schema.llmProviderApiKeyModelsTable),
          ),
        ),
      )
      .returning({ id: schema.modelsTable.id });

    return orphaned.length;
  }

  /**
   * Update model details (pricing + modalities) by its internal UUID.
   */
  static async update(id: string, data: PatchModelBody): Promise<Model | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (data.customPricePerMillionInput !== undefined) {
      set.customPricePerMillionInput = data.customPricePerMillionInput;
    }
    if (data.customPricePerMillionOutput !== undefined) {
      set.customPricePerMillionOutput = data.customPricePerMillionOutput;
    }
    if (data.customPricePerMillionCacheRead !== undefined) {
      set.customPricePerMillionCacheRead = data.customPricePerMillionCacheRead;
    }
    if (data.customPricePerMillionCacheWrite !== undefined) {
      set.customPricePerMillionCacheWrite =
        data.customPricePerMillionCacheWrite;
    }
    if (data.ignored !== undefined) {
      set.ignored = data.ignored;
    }
    if (data.inputModalities !== undefined) {
      set.inputModalities = data.inputModalities;
    }
    if (data.outputModalities !== undefined) {
      set.outputModalities = data.outputModalities;
    }
    if (data.embeddingDimensions !== undefined) {
      set.embeddingDimensions = data.embeddingDimensions;
    }
    if (data.configuredParameters !== undefined) {
      set.configuredParameters = data.configuredParameters;
    }

    const [result] = await db
      .update(schema.modelsTable)
      .set(set)
      .where(eq(schema.modelsTable.id, id))
      .returning();

    return result || null;
  }

  /**
   * Ensure a model entry exists for the given modelId and provider.
   * Newly inserted rows are marked as discovered via LLM Proxy so custom
   * models can be priced for metrics. Existing synced provider models keep
   * their source classification so deleting the provider key can clean them up.
   */
  static async ensureModelExists(
    modelId: string,
    provider: SupportedProvider,
  ): Promise<Model | null> {
    // RETURNING yields a row only when this call did the insert, which is what
    // tells the caller a model was seen for the first time and still needs its
    // registry data. On conflict it yields nothing, so a repeat sighting costs
    // one statement and leaves the existing row untouched.
    const [inserted] = await db
      .insert(schema.modelsTable)
      .values({
        externalId: `${provider}/${modelId}`,
        provider,
        modelId,
        discoveredViaLlmProxy: true,
        lastSyncedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    return inserted ?? null;
  }

  /**
   * Write registry-sourced price and limits onto a model, leaving every other
   * column (custom prices, team links, provenance) as it is.
   */
  static async applyRegistryCapabilities(
    id: string,
    capabilities: {
      promptPricePerToken: string | null;
      completionPricePerToken: string | null;
      cacheReadPricePerToken: string | null;
      cacheWritePricePerToken: string | null;
      contextLength: number | null;
      outputLength: number | null;
      supportsToolCalling: boolean | null;
    },
  ): Promise<void> {
    await db
      .update(schema.modelsTable)
      .set({ ...capabilities, lastSyncedAt: new Date() })
      .where(eq(schema.modelsTable.id, id));
  }

  /**
   * Get effective pricing for a model.
   *
   * Input/output price uses 3-tier priority:
   * 1. Custom admin-set price (customPricePerMillionInput/Output) — if non-null
   * 2. models.dev synced price (promptPricePerToken/completionPricePerToken × 1M) — if non-null
   * 3. Default fallback ($30 for mini/haiku/nano models, $50 for others)
   *
   * Cache read/write price uses its own 3-tier priority:
   * 1. Custom admin-set cache price — if non-null
   * 2. models.dev synced cache price — if non-null
   * 3. Derived from the effective input price via the provider's cache multiplier
   *
   * Cache prices are null when the provider has no cache pricing model and none
   * was synced/set (so cache cost is not fabricated for non-caching providers).
   */
  static getEffectivePricing(
    model: Model | null,
    modelId?: string,
    /** Provider hint used for cache-price derivation when `model` is null (default tier). */
    provider?: SupportedProvider,
  ): EffectivePricing {
    const { pricePerMillionInput, pricePerMillionOutput, source } =
      ModelModel.getEffectiveBasePricing(model, modelId, provider);
    const cache = ModelModel.getEffectiveCachePricing(
      model,
      pricePerMillionInput,
      provider,
    );

    return {
      pricePerMillionInput,
      pricePerMillionOutput,
      source,
      ...cache,
    };
  }

  /**
   * Resolve the effective input/output price (per million) and its source.
   */
  private static getEffectiveBasePricing(
    model: Model | null,
    modelId?: string,
    provider?: SupportedProvider,
  ): {
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
    source: PriceSource;
  } {
    // Tier 1: Custom admin-set price
    if (
      model?.customPricePerMillionInput != null &&
      model?.customPricePerMillionOutput != null
    ) {
      return {
        pricePerMillionInput: model.customPricePerMillionInput,
        pricePerMillionOutput: model.customPricePerMillionOutput,
        source: "custom",
      };
    }

    // Tier 2: registry-synced price (convert per-token to per-million). The
    // stored columns do not record which registry supplied them, so the source
    // is re-derived by re-running the AWS snapshot lookup. AWS only fills what
    // models.dev omits, so matching the stored value is what identifies it as
    // the source; a mismatch means the registry won. When both agree the
    // attribution is ambiguous and either label describes the same number.
    if (
      model?.promptPricePerToken != null &&
      model?.completionPricePerToken != null
    ) {
      const awsPrices = resolveBedrockAwsPrices({
        provider: model.provider,
        modelId: model.modelId,
      });
      // Compared as numbers: both sides are decimal strings, but the stored one
      // has been through Postgres numeric and carries its scale's trailing
      // zeros, so "0.0000033" and "0.00000330" are the same price.
      const samePrice = (a: string | null, b: string) =>
        a != null && Number.parseFloat(a) === Number.parseFloat(b);
      const syncedSource: PriceSource =
        samePrice(
          awsPrices?.promptPricePerToken ?? null,
          model.promptPricePerToken,
        ) &&
        samePrice(
          awsPrices?.completionPricePerToken ?? null,
          model.completionPricePerToken,
        )
          ? "aws"
          : "models_dev";
      return {
        pricePerMillionInput: formatPerMillionPrice(
          Number.parseFloat(model.promptPricePerToken) * 1_000_000,
        ),
        pricePerMillionOutput: formatPerMillionPrice(
          Number.parseFloat(model.completionPricePerToken) * 1_000_000,
        ),
        source: syncedSource,
      };
    }

    // Tier 3: Default fallback. The generic estimate below assumes an unknown
    // price exists to be approximated; for these providers none does, so it
    // fabricates one — inflating recorded spend and burning cost limits against
    // tokens nobody is billed for. vLLM is an inference server the operator
    // runs. Ollama bills no per-token rate on either transport: a self-hosted
    // server charges nothing, and its cloud offering is a flat monthly
    // subscription metered on GPU time rather than tokens.
    //
    // Listed explicitly rather than derived from the self-hosted-provider set
    // it currently matches, so that adding a keyless provider that does bill
    // per token cannot silently make its traffic free.
    const resolvedProvider = model?.provider ?? provider;
    if (
      resolvedProvider &&
      PROVIDERS_BILLING_NO_TOKEN_RATE.has(resolvedProvider)
    ) {
      return {
        pricePerMillionInput: "0.00",
        pricePerMillionOutput: "0.00",
        source: "default",
      };
    }

    const nameForDefault = model?.modelId ?? modelId ?? "";
    return {
      ...getDefaultModelPrice(nameForDefault),
      source: "default",
    };
  }

  /**
   * Resolve the effective cache read/write price (per million) and its source.
   * `effectivePricePerMillionInput` is the already-resolved input price used for
   * the multiplier-derived fallback tier.
   */
  private static getEffectiveCachePricing(
    model: Model | null,
    effectivePricePerMillionInput: string,
    providerHint?: SupportedProvider,
  ): {
    pricePerMillionCacheRead: string | null;
    pricePerMillionCacheWrite: string | null;
    cacheSource: PriceSource | null;
  } {
    // Read and write are resolved independently: a registry may price one
    // direction and not the other (e.g. OpenAI/Gemini publish a cache-read
    // price but no cache-write price), so we must not discard a known price
    // just because its counterpart is missing.
    const provider = model?.provider ?? providerHint;
    const multiplier = provider ? CACHE_PRICE_MULTIPLIERS[provider] : undefined;
    const priceIn = Number.parseFloat(effectivePricePerMillionInput);

    const read = resolveCacheDirection({
      custom: model?.customPricePerMillionCacheRead,
      syncedPerToken: model?.cacheReadPricePerToken,
      multiplierFactor: multiplier?.read,
      effectivePricePerMillionInput: priceIn,
    });
    const write = resolveCacheDirection({
      custom: model?.customPricePerMillionCacheWrite,
      syncedPerToken: model?.cacheWritePricePerToken,
      multiplierFactor: multiplier?.write,
      effectivePricePerMillionInput: priceIn,
    });

    if (read.price === null && write.price === null) {
      // Provider has no cache pricing model; leave cache unpriced.
      return {
        pricePerMillionCacheRead: null,
        pricePerMillionCacheWrite: null,
        cacheSource: null,
      };
    }

    return {
      pricePerMillionCacheRead: read.price,
      pricePerMillionCacheWrite: write.price,
      cacheSource: combineCacheSource(read.source, write.source),
    };
  }

  /**
   * Calculate TOON cost savings for a model based on tokens saved.
   * Looks up the model and its effective pricing, then computes savings.
   */
  static async calculateCostSavings(
    modelId: string,
    tokensSaved: number,
    provider: SupportedProvider,
  ): Promise<number> {
    const modelEntry = await ModelModel.findByProviderAndModelId(
      provider,
      modelId,
    );
    const pricing = ModelModel.getEffectivePricing(
      modelEntry,
      modelId,
      provider,
    );
    const inputPricePerToken = Number(pricing.pricePerMillionInput) / 1_000_000;
    return tokensSaved * inputPricePerToken;
  }

  /**
   * Find model by modelId only, without provider disambiguation.
   * WARNING: Prefer `findByProviderAndModelId` — this method may return an
   * arbitrary match when multiple providers share the same model name.
   * Only used by LimitModel where the usage table doesn't store provider.
   */
  static async findByModelIdOnly(modelId: string): Promise<Model | null> {
    const [result] = await db
      .select()
      .from(schema.modelsTable)
      .where(eq(schema.modelsTable.modelId, modelId))
      .limit(1);

    return result || null;
  }

  static async findByModelIdsOnly(
    modelIds: string[],
  ): Promise<Map<string, Model>> {
    if (modelIds.length === 0) {
      return new Map();
    }

    const results = await db
      .select()
      .from(schema.modelsTable)
      .where(inArray(schema.modelsTable.modelId, modelIds));

    const map = new Map<string, Model>();
    for (const result of results) {
      if (!map.has(result.modelId)) {
        map.set(result.modelId, result);
      }
    }

    return map;
  }

  /**
   * Get model capabilities for API response.
   * Uses getEffectivePricing for pricing resolution.
   */
  /**
   * The context window to DISPLAY and gate on, resolved in three tiers:
   *
   * 1. A native-Ollama model with a configured `num_ctx` enforces exactly that
   *    window, because Archestra sends it on every turn.
   * 2. Otherwise, a Modelfile `num_ctx` reported by `/api/show` — Ollama applies
   *    it whether or not we send anything, and it is what actually truncates.
   * 3. Otherwise the architectural `context_length`.
   *
   * `context_length` alone overstates the window whenever Ollama is capped,
   * producing the "ring shows 262K while Ollama truncates at 8K" symptom: no
   * compaction fires, the model loses its system prompt, and nothing errors.
   * Tier 2 costs nothing — `parseOllamaParameters` already stores the value and
   * it was simply never read.
   *
   * Clamped to the architectural window, and tier 1 is gated on `ollama-native`
   * since `/v1` cannot carry `num_ctx`. Both are defence in depth for the update
   * route, which already rejects those cases: this drives the context ring, the
   * A2A step-context guard and the output-token budget, so an inflated value
   * pushes auto-compaction past the point where the conversation still fits.
   *
   * A server-level `OLLAMA_CONTEXT_LENGTH` cap remains invisible here — it is
   * absent from `/api/show` and readable only from `/api/ps` while the model is
   * loaded. Setting `num_ctx` explicitly is the escape hatch for that case.
   */
  static resolveEffectiveContextLength(model: Model): number | null {
    const architectural = model.contextLength;
    const isOllama =
      model.provider === "ollama" || model.provider === "ollama-native";

    const configured =
      model.provider === "ollama-native"
        ? sanitizeOutputLimit(model.configuredParameters?.num_ctx)
        : null;
    // Only Ollama's fetcher writes `defaultParameters` today, but gate it
    // anyway: `num_ctx` means "the window Ollama enforces" and would be
    // meaningless — and silently shrink the window — coming from anywhere else.
    const modelfile = isOllama
      ? sanitizeOutputLimit(readOllamaDefaultNumCtx(model.defaultParameters))
      : null;

    const resolved = configured ?? modelfile;
    if (resolved === null) {
      return architectural;
    }
    return architectural === null
      ? resolved
      : Math.min(resolved, architectural);
  }

  static toCapabilities(model: Model | null): ModelCapabilities {
    if (!model) {
      return {
        contextLength: null,
        inputModalities: null,
        outputModalities: null,
        supportsToolCalling: null,
        parameterCount: null,
        pricePerMillionInput: null,
        pricePerMillionOutput: null,
        isCustomPrice: false,
        priceSource: "default",
        pricePerMillionCacheRead: null,
        pricePerMillionCacheWrite: null,
        cachePriceSource: null,
      };
    }

    const pricing = ModelModel.getEffectivePricing(model);

    return {
      contextLength: ModelModel.resolveEffectiveContextLength(model),
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      supportsToolCalling: model.supportsToolCalling,
      parameterCount: model.parameterCount,
      pricePerMillionInput: pricing.pricePerMillionInput,
      pricePerMillionOutput: pricing.pricePerMillionOutput,
      isCustomPrice: pricing.source === "custom",
      priceSource: pricing.source,
      pricePerMillionCacheRead: pricing.pricePerMillionCacheRead,
      pricePerMillionCacheWrite: pricing.pricePerMillionCacheWrite,
      cachePriceSource: pricing.cacheSource,
    };
  }

  static supportsTextChat(model: Model): boolean {
    if (model.ignored) {
      return false;
    }

    if (model.embeddingDimensions !== null) {
      return false;
    }

    if (model.inputModalities && !model.inputModalities.includes("text")) {
      return false;
    }

    if (model.outputModalities && !model.outputModalities.includes("text")) {
      return false;
    }

    return true;
  }

  static supportsEmbeddings(model: Model): boolean {
    if (model.ignored) {
      return false;
    }

    return model.embeddingDimensions !== null;
  }

  static async countAll(): Promise<number> {
    const [row] = await db.select({ c: count() }).from(schema.modelsTable);
    return Number(row?.c ?? 0);
  }

  /**
   * Snapshot for audit logs (global model row — `organizationId` is unused).
   */
  // Globally scoped audit snapshot: LLM model catalog entries are platform-wide;
  // the modelsTable has no organizationId column, and the admin-only route
  // handler is likewise unscoped. Intentional match.
  static async findByIdForAudit(
    id: string,
    _organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await ModelModel.findById(id);
    if (!row) return null;

    const caps = ModelModel.toCapabilities(row);
    const teamsByModelId = await ModelTeamModel.getTeamDetailsForModels([
      row.id,
    ]);
    return {
      id: row.id,
      modelId: row.modelId,
      provider: row.provider,
      description: row.description ?? null,
      ignored: row.ignored,
      restrictedToTeams: (teamsByModelId.get(row.id) ?? []).map(
        (team) => team.name,
      ),
      embeddingDimensions: row.embeddingDimensions,
      inputModalities: row.inputModalities ?? null,
      outputModalities: row.outputModalities ?? null,
      discoveredViaLlmProxy: row.discoveredViaLlmProxy,
      // The generation parameters Archestra SENDS on every turn. Without them
      // a parameters-only save produces an empty before/after diff — the only
      // other field it moves is `updatedAt`, which the audit hook strips — so
      // "who set num_predict: 1 on a globally shared model row, and when" would
      // be unanswerable. `contextLength` below only reflects `num_ctx`.
      configuredParameters: row.configuredParameters ?? null,
      contextLength: caps.contextLength,
      pricePerMillionInput: caps.pricePerMillionInput,
      pricePerMillionOutput: caps.pricePerMillionOutput,
      isCustomPrice: caps.isCustomPrice,
      priceSource: caps.priceSource,
      pricePerMillionCacheRead: caps.pricePerMillionCacheRead,
      pricePerMillionCacheWrite: caps.pricePerMillionCacheWrite,
      cachePriceSource: caps.cachePriceSource,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  static async snapshotModelCatalogForAudit(): Promise<
    Record<string, unknown>
  > {
    return { llmModelRowCount: await ModelModel.countAll() };
  }
}

export default ModelModel;
