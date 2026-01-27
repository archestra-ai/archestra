import type { SupportedProvider } from "@shared";
import { and, eq, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  CreateModelMetadata,
  ModelCapabilities,
  ModelMetadata,
} from "@/types";

class ModelMetadataModel {
  /**
   * Find all model metadata entries
   */
  static async findAll(): Promise<ModelMetadata[]> {
    return await db.select().from(schema.modelMetadataTable);
  }

  /**
   * Find model metadata by provider and model ID
   */
  static async findByProviderAndModelId(
    provider: SupportedProvider,
    modelId: string,
  ): Promise<ModelMetadata | null> {
    const [result] = await db
      .select()
      .from(schema.modelMetadataTable)
      .where(
        and(
          eq(schema.modelMetadataTable.provider, provider),
          eq(schema.modelMetadataTable.modelId, modelId),
        ),
      );

    return result || null;
  }

  /**
   * Find model metadata for multiple provider:modelId combinations
   */
  static async findByProviderModelIds(
    keys: Array<{ provider: SupportedProvider; modelId: string }>,
  ): Promise<Map<string, ModelMetadata>> {
    if (keys.length === 0) {
      return new Map();
    }

    // Build OR conditions to filter at database level
    const conditions = keys.map((key) =>
      and(
        eq(schema.modelMetadataTable.provider, key.provider),
        eq(schema.modelMetadataTable.modelId, key.modelId),
      ),
    );

    const results = await db
      .select()
      .from(schema.modelMetadataTable)
      .where(or(...conditions));

    const map = new Map<string, ModelMetadata>();
    for (const result of results) {
      const key = `${result.provider}:${result.modelId}`;
      map.set(key, result);
    }

    return map;
  }

  /**
   * Find model metadata by external ID (e.g., "anthropic/claude-3-opus")
   */
  static async findByExternalId(
    externalId: string,
  ): Promise<ModelMetadata | null> {
    const [result] = await db
      .select()
      .from(schema.modelMetadataTable)
      .where(eq(schema.modelMetadataTable.externalId, externalId));

    return result || null;
  }

  /**
   * Create new model metadata
   */
  static async create(data: CreateModelMetadata): Promise<ModelMetadata> {
    const [result] = await db
      .insert(schema.modelMetadataTable)
      .values(data)
      .returning();

    return result;
  }

  /**
   * Upsert model metadata by provider and model ID
   */
  static async upsert(data: CreateModelMetadata): Promise<ModelMetadata> {
    const [result] = await db
      .insert(schema.modelMetadataTable)
      .values(data)
      .onConflictDoUpdate({
        target: [
          schema.modelMetadataTable.provider,
          schema.modelMetadataTable.modelId,
        ],
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
   * Bulk upsert model metadata.
   * Uses individual upserts within a transaction for simplicity and reliability.
   */
  static async bulkUpsert(
    dataArray: CreateModelMetadata[],
  ): Promise<ModelMetadata[]> {
    if (dataArray.length === 0) {
      return [];
    }

    const results: ModelMetadata[] = [];

    // Use transaction for atomicity
    await db.transaction(async (tx) => {
      for (const data of dataArray) {
        const [result] = await tx
          .insert(schema.modelMetadataTable)
          .values(data)
          .onConflictDoUpdate({
            target: [
              schema.modelMetadataTable.provider,
              schema.modelMetadataTable.modelId,
            ],
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
        results.push(result);
      }
    });

    return results;
  }

  /**
   * Delete model metadata by provider and model ID
   */
  static async delete(
    provider: SupportedProvider,
    modelId: string,
  ): Promise<boolean> {
    // First check if the record exists (PGLite doesn't return rowCount reliably)
    const existing = await ModelMetadataModel.findByProviderAndModelId(
      provider,
      modelId,
    );
    if (!existing) {
      return false;
    }

    await db
      .delete(schema.modelMetadataTable)
      .where(
        and(
          eq(schema.modelMetadataTable.provider, provider),
          eq(schema.modelMetadataTable.modelId, modelId),
        ),
      );

    return true;
  }

  /**
   * Delete all model metadata
   */
  static async deleteAll(): Promise<void> {
    await db.delete(schema.modelMetadataTable);
  }

  /**
   * Get model capabilities for API response
   */
  static toCapabilities(metadata: ModelMetadata | null): ModelCapabilities {
    if (!metadata) {
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
    const promptPricePerMillion = metadata.promptPricePerToken
      ? (Number.parseFloat(metadata.promptPricePerToken) * 1_000_000).toFixed(2)
      : null;
    const completionPricePerMillion = metadata.completionPricePerToken
      ? (
          Number.parseFloat(metadata.completionPricePerToken) * 1_000_000
        ).toFixed(2)
      : null;

    return {
      contextLength: metadata.contextLength,
      inputModalities: metadata.inputModalities,
      outputModalities: metadata.outputModalities,
      supportsToolCalling: metadata.supportsToolCalling,
      pricePerMillionInput: promptPricePerMillion,
      pricePerMillionOutput: completionPricePerMillion,
    };
  }
}

export default ModelMetadataModel;
