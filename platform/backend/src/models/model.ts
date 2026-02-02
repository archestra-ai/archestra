import type { SupportedProvider } from "@shared";
import { and, eq, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { CreateModel, Model, ModelCapabilities } from "@/types";

class ModelModel {
  /**
   * Find all models
   */
  static async findAll(): Promise<Model[]> {
    return await db.select().from(schema.modelsTable);
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
   * Upsert model by provider and model ID
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
   * Get model capabilities for API response
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
      };
    }

    // Convert per-token price to per-million-token price
    const promptPricePerMillion = model.promptPricePerToken
      ? (Number.parseFloat(model.promptPricePerToken) * 1_000_000).toFixed(2)
      : null;
    const completionPricePerMillion = model.completionPricePerToken
      ? (Number.parseFloat(model.completionPricePerToken) * 1_000_000).toFixed(
          2,
        )
      : null;

    return {
      contextLength: model.contextLength,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      supportsToolCalling: model.supportsToolCalling,
      pricePerMillionInput: promptPricePerMillion,
      pricePerMillionOutput: completionPricePerMillion,
    };
  }
}

export default ModelModel;
