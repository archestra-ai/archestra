import type { SupportedProvider } from "@shared";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  CreateModel,
  Model,
  ModelCapabilities,
  PriceSource,
  UpdateModelPricing,
} from "@/types";

/**
 * Effective pricing result with source tracking.
 */
export interface EffectivePricing {
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
  source: PriceSource;
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

class ModelModel {
  /**
   * Find all models
   */
  static async findAll(params?: {
    search?: string;
    provider?: SupportedProvider;
  }): Promise<Model[]> {
    const conditions = [];

    if (params?.search) {
      conditions.push(ilike(schema.modelsTable.modelId, `%${params.search}%`));
    }
    if (params?.provider) {
      conditions.push(eq(schema.modelsTable.provider, params.provider));
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
          contextLength: data.contextLength,
          inputModalities: data.inputModalities,
          outputModalities: data.outputModalities,
          supportsToolCalling: data.supportsToolCalling,
          promptPricePerToken: data.promptPricePerToken,
          completionPricePerToken: data.completionPricePerToken,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
          // NOTE: customPricePerMillionInput/Output intentionally NOT updated
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
    const results = await db.transaction(async (tx) => {
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
              contextLength: sql`excluded.context_length`,
              inputModalities: sql`excluded.input_modalities`,
              outputModalities: sql`excluded.output_modalities`,
              supportsToolCalling: sql`excluded.supports_tool_calling`,
              promptPricePerToken: sql`excluded.prompt_price_per_token`,
              completionPricePerToken: sql`excluded.completion_price_per_token`,
              lastSyncedAt: sql`excluded.last_synced_at`,
              updatedAt: sql`NOW()`,
              // NOTE: customPricePerMillionInput/Output intentionally NOT updated
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
   * Update custom pricing for a model by its internal UUID.
   * Set to null to reset to default pricing.
   */
  static async updatePricing(
    id: string,
    data: UpdateModelPricing,
  ): Promise<Model | null> {
    const [result] = await db
      .update(schema.modelsTable)
      .set({
        customPricePerMillionInput: data.customPricePerMillionInput,
        customPricePerMillionOutput: data.customPricePerMillionOutput,
        updatedAt: new Date(),
      })
      .where(eq(schema.modelsTable.id, id))
      .returning();

    return result || null;
  }

  /**
   * Ensure a model entry exists for the given modelId and provider.
   * Creates a stub entry with ON CONFLICT DO NOTHING if it doesn't exist.
   * Used by LLM proxy to ensure models are tracked even before models.dev sync.
   */
  static async ensureModelExists(
    modelId: string,
    provider: SupportedProvider,
  ): Promise<void> {
    await db
      .insert(schema.modelsTable)
      .values({
        externalId: `${provider}/${modelId}`,
        provider,
        modelId,
        lastSyncedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [schema.modelsTable.provider, schema.modelsTable.modelId],
      });
  }

  /**
   * Get effective pricing for a model using 3-tier priority:
   * 1. Custom admin-set price (customPricePerMillionInput/Output) — if non-null
   * 2. models.dev synced price (promptPricePerToken/completionPricePerToken × 1M) — if non-null
   * 3. Default fallback ($30 for mini/haiku/nano models, $50 for others)
   */
  static getEffectivePricing(
    model: Model | null,
    modelId?: string,
  ): EffectivePricing {
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

    // Tier 2: models.dev synced price (convert per-token to per-million)
    if (
      model?.promptPricePerToken != null &&
      model?.completionPricePerToken != null
    ) {
      return {
        pricePerMillionInput: (
          Number.parseFloat(model.promptPricePerToken) * 1_000_000
        ).toFixed(2),
        pricePerMillionOutput: (
          Number.parseFloat(model.completionPricePerToken) * 1_000_000
        ).toFixed(2),
        source: "models_dev",
      };
    }

    // Tier 3: Default fallback
    const nameForDefault = model?.modelId ?? modelId ?? "";
    const defaults = getDefaultModelPrice(nameForDefault);
    return {
      ...defaults,
      source: "default",
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
    const pricing = ModelModel.getEffectivePricing(modelEntry, modelId);
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

  /**
   * Get model capabilities for API response.
   * Uses getEffectivePricing for pricing resolution.
   */
  static toCapabilities(model: Model | null): ModelCapabilities {
    if (!model) {
      return {
        contextLength: null,
        inputModalities: null,
        outputModalities: null,
        supportsToolCalling: null,
        pricePerMillionInput: null,
        pricePerMillionOutput: null,
        isCustomPrice: false,
        priceSource: "default",
      };
    }

    const pricing = ModelModel.getEffectivePricing(model);

    return {
      contextLength: model.contextLength,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      supportsToolCalling: model.supportsToolCalling,
      pricePerMillionInput: pricing.pricePerMillionInput,
      pricePerMillionOutput: pricing.pricePerMillionOutput,
      isCustomPrice: pricing.source === "custom",
      priceSource: pricing.source,
    };
  }
}

export default ModelModel;
