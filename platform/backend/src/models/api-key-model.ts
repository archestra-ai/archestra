import { MODEL_MARKER_PATTERNS, type SupportedProvider } from "@shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ChatApiKey, Model } from "@/types";

/**
 * Model class for the api_key_models join table.
 * Manages the many-to-many relationship between chat_api_keys and models.
 */
class ApiKeyModelModel {
  /**
   * Link multiple models to an API key.
   * This performs a bulk insert, ignoring duplicates.
   */
  static async linkModelsToApiKey(
    apiKeyId: string,
    modelIds: string[],
  ): Promise<void> {
    if (modelIds.length === 0) {
      return;
    }

    // Use batch size to avoid PostgreSQL parameter limits
    const BATCH_SIZE = 500;

    for (let i = 0; i < modelIds.length; i += BATCH_SIZE) {
      const batch = modelIds.slice(i, i + BATCH_SIZE);
      const values = batch.map((modelId) => ({
        apiKeyId,
        modelId,
      }));

      await db
        .insert(schema.apiKeyModelsTable)
        .values(values)
        .onConflictDoNothing();
    }
  }

  /**
   * Get all models linked to a specific API key.
   */
  static async getModelsForApiKey(apiKeyId: string): Promise<Model[]> {
    const results = await db
      .select({
        model: schema.modelsTable,
      })
      .from(schema.apiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.apiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(eq(schema.apiKeyModelsTable.apiKeyId, apiKeyId));

    return results.map((r) => r.model);
  }

  /**
   * Get all API keys linked to a specific model.
   */
  static async getApiKeysForModel(modelId: string): Promise<ChatApiKey[]> {
    const results = await db
      .select({
        apiKey: schema.chatApiKeysTable,
      })
      .from(schema.apiKeyModelsTable)
      .innerJoin(
        schema.chatApiKeysTable,
        eq(schema.apiKeyModelsTable.apiKeyId, schema.chatApiKeysTable.id),
      )
      .where(eq(schema.apiKeyModelsTable.modelId, modelId));

    return results.map((r) => r.apiKey);
  }

  /**
   * Sync models for an API key.
   * This replaces all existing model links with the new set.
   * Also detects and marks the "fastest" and "best" models for the provider.
   *
   * @param apiKeyId - The database ID of the API key
   * @param models - Array of models with their database ID and modelId string
   * @param provider - The provider for pattern matching
   */
  static async syncModelsForApiKey(
    apiKeyId: string,
    models: Array<{ id: string; modelId: string }>,
    provider: SupportedProvider,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Delete existing links for this API key
      await tx
        .delete(schema.apiKeyModelsTable)
        .where(eq(schema.apiKeyModelsTable.apiKeyId, apiKeyId));

      // Insert new links
      if (models.length > 0) {
        // Detect fastest and best models using pattern matching
        // Patterns are checked in order (first pattern = highest priority)
        const patterns = MODEL_MARKER_PATTERNS[provider];
        const sorted = [...models].sort((a, b) =>
          a.modelId.localeCompare(b.modelId),
        );

        // Find first matching model respecting pattern priority order
        const fastestModel = findFirstMatchByPatternPriority(
          sorted,
          patterns.fastest,
        );
        const bestModel = findFirstMatchByPatternPriority(
          sorted,
          patterns.best,
        );

        // Build values with markers
        const values = models.map((model) => ({
          apiKeyId,
          modelId: model.id,
          isFastest: model.id === fastestModel?.id,
          isBest: model.id === bestModel?.id,
        }));

        // Batch insert
        const BATCH_SIZE = 500;
        for (let i = 0; i < values.length; i += BATCH_SIZE) {
          const batch = values.slice(i, i + BATCH_SIZE);
          await tx.insert(schema.apiKeyModelsTable).values(batch);
        }
      }
    });
  }

  /**
   * Get all models with their linked API keys.
   * Only returns models that have at least one API key linked.
   * Includes isFastest and isBest markers (true if ANY linked API key has the marker).
   */
  static async getAllModelsWithApiKeys(): Promise<
    Array<{
      model: Model;
      isFastest: boolean;
      isBest: boolean;
      apiKeys: Array<{
        id: string;
        name: string;
        provider: string;
        scope: string;
        isSystem: boolean;
      }>;
    }>
  > {
    // Get all relationships with model and API key data in a single query
    // This only returns models that have at least one API key linked
    // Order by provider and modelId for consistent display
    const relationships = await db
      .select({
        model: schema.modelsTable,
        isFastest: schema.apiKeyModelsTable.isFastest,
        isBest: schema.apiKeyModelsTable.isBest,
        apiKeyId: schema.chatApiKeysTable.id,
        apiKeyName: schema.chatApiKeysTable.name,
        apiKeyProvider: schema.chatApiKeysTable.provider,
        apiKeyScope: schema.chatApiKeysTable.scope,
        apiKeyIsSystem: schema.chatApiKeysTable.isSystem,
      })
      .from(schema.apiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.apiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .innerJoin(
        schema.chatApiKeysTable,
        eq(schema.apiKeyModelsTable.apiKeyId, schema.chatApiKeysTable.id),
      )
      .orderBy(
        asc(schema.modelsTable.provider),
        asc(schema.modelsTable.modelId),
      );

    // Group by model, collecting API keys for each
    // isFastest/isBest are true if ANY linked API key has the marker
    const modelMap = new Map<
      string,
      {
        model: Model;
        isFastest: boolean;
        isBest: boolean;
        apiKeys: Array<{
          id: string;
          name: string;
          provider: string;
          scope: string;
          isSystem: boolean;
        }>;
      }
    >();

    for (const rel of relationships) {
      const modelId = rel.model.id;
      let entry = modelMap.get(modelId);

      if (!entry) {
        entry = {
          model: rel.model,
          isFastest: false,
          isBest: false,
          apiKeys: [],
        };
        modelMap.set(modelId, entry);
      }

      // Set markers if any relationship has them
      if (rel.isFastest) entry.isFastest = true;
      if (rel.isBest) entry.isBest = true;

      entry.apiKeys.push({
        id: rel.apiKeyId,
        name: rel.apiKeyName,
        provider: rel.apiKeyProvider,
        scope: rel.apiKeyScope,
        isSystem: rel.apiKeyIsSystem,
      });
    }

    return Array.from(modelMap.values());
  }

  /**
   * Get models for multiple API keys in a single query.
   * Returns a map of API key ID to model IDs.
   */
  static async getModelsForApiKeys(
    apiKeyIds: string[],
  ): Promise<Map<string, string[]>> {
    if (apiKeyIds.length === 0) {
      return new Map();
    }

    const results = await db
      .select({
        apiKeyId: schema.apiKeyModelsTable.apiKeyId,
        modelId: schema.apiKeyModelsTable.modelId,
      })
      .from(schema.apiKeyModelsTable)
      .where(inArray(schema.apiKeyModelsTable.apiKeyId, apiKeyIds));

    const map = new Map<string, string[]>();
    for (const result of results) {
      if (!map.has(result.apiKeyId)) {
        map.set(result.apiKeyId, []);
      }
      map.get(result.apiKeyId)?.push(result.modelId);
    }

    return map;
  }

  /**
   * Delete all model links for an API key.
   */
  static async deleteLinksForApiKey(apiKeyId: string): Promise<void> {
    await db
      .delete(schema.apiKeyModelsTable)
      .where(eq(schema.apiKeyModelsTable.apiKeyId, apiKeyId));
  }

  /**
   * Get count of linked models for an API key.
   */
  static async getModelCountForApiKey(apiKeyId: string): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.apiKeyModelsTable)
      .where(eq(schema.apiKeyModelsTable.apiKeyId, apiKeyId));

    return result?.count ?? 0;
  }

  /**
   * Get unique models for a list of API key IDs.
   * Returns models with their data, ordered by provider and modelId.
   */
  static async getModelsForApiKeyIds(apiKeyIds: string[]): Promise<Model[]> {
    if (apiKeyIds.length === 0) {
      return [];
    }

    // Get unique models linked to any of the provided API keys
    const results = await db
      .selectDistinctOn([schema.modelsTable.id], {
        model: schema.modelsTable,
      })
      .from(schema.apiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.apiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(inArray(schema.apiKeyModelsTable.apiKeyId, apiKeyIds))
      .orderBy(
        schema.modelsTable.id,
        asc(schema.modelsTable.provider),
        asc(schema.modelsTable.modelId),
      );

    return results.map((r) => r.model);
  }
  /**
   * Get the "best" model for a specific API key.
   * Returns the model marked with is_best=true, or falls back to the first model.
   */
  static async getBestModel(apiKeyId: string): Promise<Model | null> {
    const [result] = await db
      .select({ model: schema.modelsTable })
      .from(schema.apiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.apiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(
        and(
          eq(schema.apiKeyModelsTable.apiKeyId, apiKeyId),
          eq(schema.apiKeyModelsTable.isBest, true),
        ),
      )
      .limit(1);

    if (result?.model) {
      return result.model;
    }

    return ApiKeyModelModel.getFirstModelForApiKey(apiKeyId);
  }

  /**
   * Get the "fastest" model for a specific API key.
   * Returns the model marked with is_fastest=true, or falls back to the first model.
   */
  static async getFastestModel(apiKeyId: string): Promise<Model | null> {
    const [result] = await db
      .select({ model: schema.modelsTable })
      .from(schema.apiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.apiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(
        and(
          eq(schema.apiKeyModelsTable.apiKeyId, apiKeyId),
          eq(schema.apiKeyModelsTable.isFastest, true),
        ),
      )
      .limit(1);

    if (result?.model) {
      return result.model;
    }

    return ApiKeyModelModel.getFirstModelForApiKey(apiKeyId);
  }

  /**
   * Get the first model linked to an API key (used as fallback).
   */
  static async getFirstModelForApiKey(apiKeyId: string): Promise<Model | null> {
    const [result] = await db
      .select({ model: schema.modelsTable })
      .from(schema.apiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.apiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(eq(schema.apiKeyModelsTable.apiKeyId, apiKeyId))
      .orderBy(asc(schema.modelsTable.modelId))
      .limit(1);

    return result?.model ?? null;
  }
}

export default ApiKeyModelModel;

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Find the first model matching patterns, respecting pattern priority order.
 * Patterns are checked in order (first pattern = highest priority).
 * For each pattern, returns the first alphabetically sorted match.
 */
function findFirstMatchByPatternPriority(
  sortedModels: Array<{ id: string; modelId: string }>,
  patterns: string[],
): { id: string; modelId: string } | undefined {
  for (const pattern of patterns) {
    const match = sortedModels.find((m) =>
      m.modelId.toLowerCase().includes(pattern.toLowerCase()),
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}
