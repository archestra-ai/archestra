import {
  type CompleteModelSelection,
  MODEL_MARKER_PATTERNS,
  type SupportedProvider,
} from "@archestra/shared";
import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { LlmProviderApiKey, Model } from "@/types";
import ModelModel from "./model";

/** Aggregate of an API key's linked-model count and oldest sync timestamp. */
export interface ModelSyncState {
  apiKeyId: string;
  linkedModelCount: number;
  oldestLastSyncedAt: Date | null;
}

/**
 * Model class for the api_key_models join table.
 * Manages the many-to-many relationship between chat_api_keys and models.
 */
class LlmProviderApiKeyModelLinkModel {
  /**
   * Link multiple models to an API key.
   * This performs a bulk insert, ignoring duplicates.
   */
  static async linkModelsToApiKey(
    apiKeyId: string,
    modelIds: string[],
  ): Promise<void> {
    const uniqueModelIds = Array.from(new Set(modelIds));

    if (uniqueModelIds.length === 0) {
      return;
    }

    // Use batch size to avoid PostgreSQL parameter limits
    const BATCH_SIZE = 500;

    for (let i = 0; i < uniqueModelIds.length; i += BATCH_SIZE) {
      const batch = uniqueModelIds.slice(i, i + BATCH_SIZE);
      const values = batch.map((modelId) => ({
        apiKeyId,
        modelId,
      }));

      await db
        .insert(schema.llmProviderApiKeyModelsTable)
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
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyId));

    return results.map((r) => r.model);
  }

  /**
   * Get all API keys linked to a specific model.
   */
  static async getApiKeysForModel(
    modelId: string,
  ): Promise<LlmProviderApiKey[]> {
    const results = await db
      .select({
        apiKey: schema.llmProviderApiKeysTable,
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.llmProviderApiKeyModelsTable.apiKeyId,
          schema.llmProviderApiKeysTable.id,
        ),
      )
      .where(eq(schema.llmProviderApiKeyModelsTable.modelId, modelId));

    return results.map((r) => r.apiKey);
  }

  /**
   * Where a provider-facing model id is served, for providers whose keys are
   * endpoints. Answers with the linked key ids, or null when the model is not
   * in the catalog at all.
   *
   * The distinction matters to callers deciding whether an endpoint can run a
   * model: an empty array is "synced and served nowhere", while null is "never
   * seen" — for instance a model an operator has just deployed. Only the first
   * justifies treating the endpoint as unable to serve it.
   */
  static async findApiKeyIdsServingModelId(params: {
    provider: SupportedProvider;
    modelId: string;
  }): Promise<string[] | null> {
    const model = await ModelModel.findByProviderAndModelId(
      params.provider,
      params.modelId,
    );
    if (!model) {
      return null;
    }

    const rows = await db
      .select({ apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId })
      .from(schema.llmProviderApiKeyModelsTable)
      .where(eq(schema.llmProviderApiKeyModelsTable.modelId, model.id));

    return rows.map((row) => row.apiKeyId);
  }

  /**
   * Sync models for an API key.
   * This replaces the set of model links with the new set (stale links are
   * deleted, current ones updated in place). Also detects and marks the
   * "best" model for the provider.
   *
   * `recommendedForAgents` is the endpoint-scoped agent-suitability verdict.
   * By default a null verdict keeps the link's last known one (Ollama's
   * `/api/show` is time-boxed and degrades to null per model, and a transient
   * miss must not silently un-flag a 4B model). `overwriteRecommendedForAgents`
   * writes the verdict verbatim: an Ollama tag is mutable (`ollama create` can
   * repoint it), so a full refresh has to stay the way to correct a stale one.
   *
   * @param apiKeyId - The database ID of the API key
   * @param models - Array of models with their database ID, modelId string, and verdict
   * @param provider - The provider for pattern matching
   * @param options - `overwriteRecommendedForAgents` for the full-refresh path
   */
  static async syncModelsForApiKey(
    apiKeyId: string,
    models: Array<{
      id: string;
      modelId: string;
      recommendedForAgents?: boolean | null;
    }>,
    provider: SupportedProvider,
    options: { overwriteRecommendedForAgents?: boolean } = {},
  ): Promise<void> {
    const uniqueModels = Array.from(
      new Map(models.map((model) => [model.id, model])).values(),
    );

    await withDbTransaction(async (tx) => {
      // Delete links to models the provider no longer serves. Kept links are
      // updated in place below so their last known verdict can survive a
      // sync that learned nothing.
      await tx.delete(schema.llmProviderApiKeyModelsTable).where(
        uniqueModels.length > 0
          ? and(
              eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyId),
              notInArray(
                schema.llmProviderApiKeyModelsTable.modelId,
                uniqueModels.map((model) => model.id),
              ),
            )
          : eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyId),
      );

      // Insert new links
      if (uniqueModels.length > 0) {
        // Detect the best model using pattern matching
        // Patterns are checked in order (first pattern = highest priority)
        const patterns = MODEL_MARKER_PATTERNS[provider];
        const sorted = [...uniqueModels].sort((a, b) =>
          a.modelId.localeCompare(b.modelId),
        );

        // Find first matching model respecting pattern priority order
        const bestModel = findFirstMatchByPatternPriority(sorted, patterns);

        // Build values with markers
        const values = uniqueModels.map((model) => ({
          apiKeyId,
          modelId: model.id,
          isBest: model.id === bestModel?.id,
          recommendedForAgents: model.recommendedForAgents ?? null,
        }));

        // Batch insert
        const BATCH_SIZE = 500;
        for (let i = 0; i < values.length; i += BATCH_SIZE) {
          const batch = values.slice(i, i + BATCH_SIZE);
          await tx
            .insert(schema.llmProviderApiKeyModelsTable)
            .values(batch)
            .onConflictDoUpdate({
              target: [
                schema.llmProviderApiKeyModelsTable.apiKeyId,
                schema.llmProviderApiKeyModelsTable.modelId,
              ],
              set: {
                isBest: sql`excluded.is_best`,
                recommendedForAgents: options.overwriteRecommendedForAgents
                  ? sql`excluded.recommended_for_agents`
                  : sql`COALESCE(excluded.recommended_for_agents, ${schema.llmProviderApiKeyModelsTable.recommendedForAgents})`,
              },
            });
        }
      }
    });
  }

  /**
   * Get all models with their linked API keys.
   * Only returns models that have at least one API key linked.
   * Includes isBest marker (true if ANY linked API key has the marker).
   */
  static async getAllModelsWithApiKeys(): Promise<
    Array<{
      model: Model;
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
        isBest: schema.llmProviderApiKeyModelsTable.isBest,
        apiKeyId: schema.llmProviderApiKeysTable.id,
        apiKeyName: schema.llmProviderApiKeysTable.name,
        apiKeyProvider: schema.llmProviderApiKeysTable.provider,
        apiKeyScope: schema.llmProviderApiKeysTable.scope,
        apiKeyIsSystem: schema.llmProviderApiKeysTable.isSystem,
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.llmProviderApiKeyModelsTable.apiKeyId,
          schema.llmProviderApiKeysTable.id,
        ),
      )
      .orderBy(
        asc(schema.modelsTable.provider),
        asc(schema.modelsTable.modelId),
      );

    // Group by model, collecting API keys for each
    // isBest is true if ANY linked API key has the marker
    const modelMap = new Map<
      string,
      {
        model: Model;
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
          isBest: false,
          apiKeys: [],
        };
        modelMap.set(modelId, entry);
      }

      // Set markers if any relationship has them
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
        apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId,
        modelId: schema.llmProviderApiKeyModelsTable.modelId,
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .where(inArray(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyIds));

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
      .delete(schema.llmProviderApiKeyModelsTable)
      .where(eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyId));
  }

  /**
   * Get count of linked models for an API key.
   */
  static async getModelCountForApiKey(apiKeyId: string): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.llmProviderApiKeyModelsTable)
      .where(eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyId));

    return result?.count ?? 0;
  }

  static async getModelSyncStatesForApiKeys(
    apiKeyIds: string[],
  ): Promise<Map<string, ModelSyncState>> {
    if (apiKeyIds.length === 0) {
      return new Map();
    }

    const results = await db
      .select({
        apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId,
        linkedModelCount: sql<number>`count(*)::int`.as("linked_model_count"),
        oldestLastSyncedAt:
          sql<Date | null>`min(${schema.modelsTable.lastSyncedAt})`.as(
            "oldest_last_synced_at",
          ),
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(inArray(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyIds))
      .groupBy(schema.llmProviderApiKeyModelsTable.apiKeyId);

    return new Map(
      results.map((result) => [
        result.apiKeyId,
        {
          ...result,
          oldestLastSyncedAt: toDateOrNull(result.oldestLastSyncedAt),
        },
      ]),
    );
  }

  static async getLinkedModelSelectionKeys(
    selections: CompleteModelSelection[],
  ): Promise<Set<string>> {
    if (selections.length === 0) {
      return new Set();
    }

    const uniqueSelections = Array.from(
      new Map(
        selections.map((selection) => [selectionKey(selection), selection]),
      ).values(),
    );

    const conditions = uniqueSelections.map((selection) =>
      and(
        eq(schema.llmProviderApiKeyModelsTable.modelId, selection.modelId),
        eq(schema.llmProviderApiKeyModelsTable.apiKeyId, selection.apiKeyId),
      ),
    );
    const whereClause = or(...conditions);
    if (!whereClause) {
      return new Set();
    }

    const rows = await db
      .select({
        modelId: schema.llmProviderApiKeyModelsTable.modelId,
        apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId,
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .where(whereClause);

    return new Set(rows.map(selectionKey));
  }

  /**
   * Get unique models for a list of API key IDs.
   * Returns models with their data and isBest marker,
   * ordered by provider and modelId.
   * A model is marked as best if ANY of the provided API keys marks it so.
   *
   * `recommendedForAgents` aggregates pessimistically: the listing collapses
   * the given keys' links into one row per model, so if ANY key's endpoint
   * serves a build judged unfit, the merged row carries `false` — over-warning
   * beats a key hiding another key's evidence. Keys with no evidence (null)
   * don't vote; all-null stays null.
   */
  static async getModelsForApiKeyIds(apiKeyIds: string[]): Promise<
    Array<{
      model: Model;
      isBest: boolean;
      recommendedForAgents: boolean | null;
    }>
  > {
    if (apiKeyIds.length === 0) {
      return [];
    }

    // Get models with aggregated best marker (true if ANY linked key has the marker)
    const results = await db
      .select({
        model: schema.modelsTable,
        isBest:
          sql<boolean>`bool_or(${schema.llmProviderApiKeyModelsTable.isBest})`.as(
            "is_best_agg",
          ),
        // bool_and skips NULLs: false if any key says false, true if every
        // key with evidence says true, null when no key has evidence.
        recommendedForAgents: sql<
          boolean | null
        >`bool_and(${schema.llmProviderApiKeyModelsTable.recommendedForAgents})`.as(
          "recommended_for_agents_agg",
        ),
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(inArray(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyIds))
      .groupBy(schema.modelsTable.id)
      .orderBy(
        asc(schema.modelsTable.provider),
        asc(schema.modelsTable.modelId),
      );

    return results.map((r) => ({
      model: r.model,
      isBest: r.isBest,
      recommendedForAgents: r.recommendedForAgents,
    }));
  }
  /**
   * Get a per-user provider's models that have been synced by ANY member of the
   * org (across every member's personal key for that provider).
   *
   * Per-user providers (GitHub Copilot) catalogue the same models for everyone —
   * only the credential is resolved per-user at request time — so the picker for
   * a member who hasn't connected should still list the provider's models
   * (flagged "connect your account") rather than show an empty list. Scoping to
   * org keys keeps it to models that have actually been connected in this org.
   * A model is `isBest` if any linked key in the org marks it so.
   */
  static async getOrgModelsForPerUserProvider(
    organizationId: string,
    provider: SupportedProvider,
  ): Promise<Array<{ model: Model; isBest: boolean }>> {
    const results = await db
      .select({
        model: schema.modelsTable,
        isBest:
          sql<boolean>`bool_or(${schema.llmProviderApiKeyModelsTable.isBest})`.as(
            "is_best_agg",
          ),
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.llmProviderApiKeyModelsTable.apiKeyId,
          schema.llmProviderApiKeysTable.id,
        ),
      )
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, provider),
          eq(schema.modelsTable.provider, provider),
        ),
      )
      .groupBy(schema.modelsTable.id)
      .orderBy(
        asc(schema.modelsTable.provider),
        asc(schema.modelsTable.modelId),
      );

    return results.map((r) => ({
      model: r.model,
      isBest: r.isBest,
    }));
  }

  /**
   * Get the "best" model for a specific API key.
   * Returns the model marked with is_best=true, or falls back to the first model.
   */
  /**
   * Ranked (model, key) pairs across the given API keys — the "best available
   * model" fallback for resolution. Rows are ordered is_best first, then by
   * provider and model id, so the first row is a deterministic best pick.
   * `modelId` is the models.id UUID (matches the model_id FK columns).
   *
   * Only chat-capable, non-ignored models are returned, matching the model
   * picker (`supportsTextChat`), so resolution never auto-selects a model the
   * UI hides or that cannot serve chat.
   */
  static async getRankedModelsForApiKeys(
    apiKeyIds: string[],
  ): Promise<Array<{ modelId: string; apiKeyId: string; isBest: boolean }>> {
    if (apiKeyIds.length === 0) {
      return [];
    }
    const rows = await db
      .select({
        model: schema.modelsTable,
        apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId,
        isBest: schema.llmProviderApiKeyModelsTable.isBest,
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(inArray(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyIds))
      .orderBy(
        desc(schema.llmProviderApiKeyModelsTable.isBest),
        asc(schema.modelsTable.provider),
        asc(schema.modelsTable.modelId),
      );

    return rows
      .filter((row) => ModelModel.supportsTextChat(row.model))
      .map((row) => ({
        modelId: row.model.id,
        apiKeyId: row.apiKeyId,
        isBest: row.isBest,
      }));
  }

  static async getBestModel(apiKeyId: string): Promise<Model | null> {
    const [result] = await db
      .select({ model: schema.modelsTable })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(
        and(
          eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyId),
          eq(schema.llmProviderApiKeyModelsTable.isBest, true),
        ),
      )
      .limit(1);

    if (result?.model && ModelModel.supportsTextChat(result.model)) {
      return result.model;
    }

    return LlmProviderApiKeyModelLinkModel.getFirstModelForApiKey(apiKeyId);
  }

  /**
   * Get the "best" model for multiple API keys in two batched queries.
   * Returns the model marked with is_best=true, or falls back to the first
   * model. Both candidates are filtered through `supportsTextChat`, so a hidden
   * or non-chat model is never returned as a key's best.
   */
  static async getBestModelsForApiKeys(
    apiKeyIds: string[],
  ): Promise<Map<string, Model>> {
    if (apiKeyIds.length === 0) {
      return new Map();
    }

    const bestModels = await db
      .select({
        apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId,
        model: schema.modelsTable,
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(
        and(
          inArray(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyIds),
          eq(schema.llmProviderApiKeyModelsTable.isBest, true),
        ),
      )
      .orderBy(
        asc(schema.llmProviderApiKeyModelsTable.apiKeyId),
        asc(schema.modelsTable.modelId),
      );

    const modelsByApiKeyId = new Map<string, Model>();
    for (const result of bestModels) {
      if (ModelModel.supportsTextChat(result.model)) {
        modelsByApiKeyId.set(result.apiKeyId, result.model);
      }
    }

    const missingApiKeyIds = apiKeyIds.filter(
      (apiKeyId) => !modelsByApiKeyId.has(apiKeyId),
    );

    if (missingApiKeyIds.length === 0) {
      return modelsByApiKeyId;
    }

    const fallbackModels = await db
      .select({
        apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId,
        model: schema.modelsTable,
      })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(
        inArray(schema.llmProviderApiKeyModelsTable.apiKeyId, missingApiKeyIds),
      )
      .orderBy(
        asc(schema.llmProviderApiKeyModelsTable.apiKeyId),
        asc(schema.modelsTable.modelId),
      );

    for (const result of fallbackModels) {
      if (
        !modelsByApiKeyId.has(result.apiKeyId) &&
        ModelModel.supportsTextChat(result.model)
      ) {
        modelsByApiKeyId.set(result.apiKeyId, result.model);
      }
    }

    return modelsByApiKeyId;
  }

  /**
   * Get the first chat-capable, non-ignored model linked to an API key (used as
   * fallback). Honors `supportsTextChat` so a hidden or non-chat model — e.g. a
   * legacy completions-only model that sorts first alphabetically — is skipped.
   */
  static async getFirstModelForApiKey(apiKeyId: string): Promise<Model | null> {
    const rows = await db
      .select({ model: schema.modelsTable })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.modelsTable,
        eq(schema.llmProviderApiKeyModelsTable.modelId, schema.modelsTable.id),
      )
      .where(eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKeyId))
      .orderBy(asc(schema.modelsTable.modelId));

    return (
      rows.find((row) => ModelModel.supportsTextChat(row.model))?.model ?? null
    );
  }
}

export default LlmProviderApiKeyModelLinkModel;

// ============================================================================
// Helper functions
// ============================================================================

export function selectionKey(selection: CompleteModelSelection): string {
  return `${selection.apiKeyId}:${selection.modelId}`;
}

function toDateOrNull(value: Date | string | null): Date | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  return new Date(value);
}

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
