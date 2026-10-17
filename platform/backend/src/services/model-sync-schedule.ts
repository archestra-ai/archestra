import {
  isProviderApiKeyOptional,
  type SupportedProvider,
  TimeInMs,
} from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  type ModelSyncState,
  TeamModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import type { LlmProviderApiKeyForModelSync } from "@/types";
import { mapWithConcurrency } from "@/utils/concurrency";

// ===== Public API =====

/**
 * One tick of the `llm_model_sync` periodic task: refresh models.dev metadata
 * when it is due, then re-sync every API key, in any organization, whose
 * models are older than its provider's TTL. Each due key is marked in the
 * shared cache before its sync, so a key that fails or lists no models is
 * tried at most once per TTL across all pods.
 */
export async function syncDueModels(): Promise<void> {
  await modelsDevClient.syncIfNeeded();

  const apiKeys = await LlmProviderApiKeyModel.findAllForModelSync();
  const dueKeys = await findDueApiKeys(apiKeys);
  if (dueKeys.length === 0) {
    return;
  }

  await markSyncAttempts(dueKeys);

  // System keys are synced by the system key manager, which handles every
  // keyless provider of an organization in one call.
  const systemKeysByOrganization = new Map<
    string,
    LlmProviderApiKeyForModelSync[]
  >();
  const regularKeys: LlmProviderApiKeyForModelSync[] = [];
  for (const apiKey of dueKeys) {
    if (shouldHandleWithSystemKeySync(apiKey)) {
      const keys = systemKeysByOrganization.get(apiKey.organizationId) ?? [];
      keys.push(apiKey);
      systemKeysByOrganization.set(apiKey.organizationId, keys);
    } else {
      regularKeys.push(apiKey);
    }
  }

  const work: Array<() => Promise<SyncOutcome[]>> = [
    ...[...systemKeysByOrganization].map(
      ([organizationId, keys]) =>
        () =>
          syncSystemKeysForOrganization({ organizationId, keys }),
    ),
    ...regularKeys.map((apiKey) => async () => [await syncOneKey(apiKey)]),
  ];
  const settled = await mapWithConcurrency(
    work,
    MODEL_SYNC_CONCURRENCY,
    (run) => run(),
  );
  const outcomes = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );

  const synced = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (synced.length > 0 || failed.length > 0) {
    logger.info(
      {
        syncedApiKeyIds: synced.map((outcome) => outcome.apiKeyId),
        failedApiKeyIds: failed.map((outcome) => outcome.apiKeyId),
      },
      "Synced LLM models for due API keys",
    );
  }
}

/**
 * The explicit "Refresh models" action: sync every key the user can use, now,
 * and report the keys that failed.
 */
export async function syncModelsForVisibleApiKeys(params: {
  organizationId: string;
  userId: string;
}): Promise<
  Array<{
    apiKeyId: string;
    name: string;
    provider: SupportedProvider;
    requiresReauthentication: boolean;
  }>
> {
  const { organizationId, userId } = params;
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const apiKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    organizationId,
    userId,
    userTeamIds,
  );
  const systemFailures = apiKeys.some(shouldHandleWithSystemKeySync)
    ? await systemKeyManager.syncSystemKeys(organizationId)
    : [];
  const results = await Promise.all(
    apiKeys.map(async (apiKey) => {
      try {
        if (shouldHandleWithSystemKeySync(apiKey)) {
          if (systemFailures?.includes(apiKey.provider))
            throw new Error("Provider model refresh failed");
        } else {
          await syncApiKeyModels(apiKey);
        }
        return null;
      } catch {
        return {
          apiKeyId: apiKey.id,
          name: apiKey.name,
          provider: apiKey.provider,
        };
      }
    }),
  );
  const failedKeys = results.filter((result) => result !== null);
  if (failedKeys.length === 0) return [];
  const currentKeys = await LlmProviderApiKeyModel.findByIds(
    failedKeys.map((key) => key.apiKeyId),
  );
  const rejectedIds = new Set(
    currentKeys
      .filter((key) => key.requiresReauthentication)
      .map((key) => key.id),
  );
  return failedKeys.map((key) => ({
    ...key,
    requiresReauthentication: rejectedIds.has(key.apiKeyId),
  }));
}

// ===== Internal helpers =====

type SyncOutcome = { apiKeyId: string; ok: boolean };

const DEFAULT_MODEL_SYNC_TTL_MS = TimeInMs.Day;
const MODEL_SYNC_TTL_BY_PROVIDER: Partial<Record<SupportedProvider, number>> = {
  openrouter: TimeInMs.Hour,
  ollama: 5 * TimeInMs.Minute,
  // Same server as `ollama`, so it needs the same TTL: on the default one-day
  // fallback a freshly `ollama pull`-ed model appeared in one provider within
  // five minutes and the other a day later, which reads as a failed pull.
  "ollama-native": 5 * TimeInMs.Minute,
  vllm: 5 * TimeInMs.Minute,
};

/** Provider fetches in flight at once in one tick. */
const MODEL_SYNC_CONCURRENCY = 4;

function modelSyncTtl(provider: SupportedProvider): number {
  return MODEL_SYNC_TTL_BY_PROVIDER[provider] ?? DEFAULT_MODEL_SYNC_TTL_MS;
}

function syncAttemptCacheKey(apiKeyId: string): AllowedCacheKey {
  return `${CacheKey.LlmModelSyncAttempt}-${apiKeyId}`;
}

/** Keys whose models are stale and that were not already tried within their TTL. */
async function findDueApiKeys(
  apiKeys: LlmProviderApiKeyForModelSync[],
): Promise<LlmProviderApiKeyForModelSync[]> {
  const now = new Date();
  const syncStates =
    await LlmProviderApiKeyModelLinkModel.getModelSyncStatesForApiKeys(
      apiKeys.map((apiKey) => apiKey.id),
    );
  const staleKeys = apiKeys.filter((apiKey) =>
    isModelSyncStateStale({
      provider: apiKey.provider,
      syncState: syncStates.get(apiKey.id),
      now,
    }),
  );
  if (staleKeys.length === 0) {
    return [];
  }

  // An attempt within the TTL settles the key whatever its outcome: a failed
  // sync leaves the links as they were, and a key that lists no models has
  // none, so without the marker those keys would be fetched on every tick.
  const attempts = await cacheManager.getMany<true>(
    staleKeys.map((apiKey) => syncAttemptCacheKey(apiKey.id)),
  );
  return staleKeys.filter(
    (apiKey) => !attempts.has(syncAttemptCacheKey(apiKey.id)),
  );
}

function isModelSyncStateStale(params: {
  provider: SupportedProvider;
  syncState?: Pick<ModelSyncState, "linkedModelCount" | "oldestLastSyncedAt">;
  now: Date;
}): boolean {
  const { provider, syncState, now } = params;

  // no usable linked models yet (unlinked key, empty provider, or failed sync)
  if (
    !syncState ||
    syncState.linkedModelCount === 0 ||
    !syncState.oldestLastSyncedAt
  ) {
    return true;
  }

  return (
    now.getTime() - syncState.oldestLastSyncedAt.getTime() >=
    modelSyncTtl(provider)
  );
}

/**
 * Written before the sync, so the marker never outlives the links the sync
 * writes: when both age out, the next tick sees a stale key with no marker.
 */
async function markSyncAttempts(
  apiKeys: LlmProviderApiKeyForModelSync[],
): Promise<void> {
  const results = await Promise.allSettled(
    apiKeys.map((apiKey) =>
      cacheManager.set(
        syncAttemptCacheKey(apiKey.id),
        true,
        modelSyncTtl(apiKey.provider),
      ),
    ),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    // The sync still runs: the worst case is one more attempt next tick.
    logger.warn(
      { failedCount: failures.length },
      "Could not record LLM model sync attempts",
    );
  }
}

async function syncOneKey(
  apiKey: LlmProviderApiKeyForModelSync,
): Promise<SyncOutcome> {
  try {
    await syncApiKeyModels(apiKey);
    return { apiKeyId: apiKey.id, ok: true };
  } catch {
    // syncApiKeyModels logs the reason.
    return { apiKeyId: apiKey.id, ok: false };
  }
}

async function syncSystemKeysForOrganization(params: {
  organizationId: string;
  keys: LlmProviderApiKeyForModelSync[];
}): Promise<SyncOutcome[]> {
  const { organizationId, keys } = params;
  let failedProviders: SupportedProvider[];
  try {
    failedProviders = await systemKeyManager.syncSystemKeys(organizationId);
  } catch (error) {
    logger.error(
      {
        organizationId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "Failed to sync system API keys",
    );
    return keys.map((apiKey) => ({ apiKeyId: apiKey.id, ok: false }));
  }
  return keys.map((apiKey) => ({
    apiKeyId: apiKey.id,
    ok: !failedProviders.includes(apiKey.provider),
  }));
}

async function syncApiKeyModels(
  apiKey: Pick<
    LlmProviderApiKeyForModelSync,
    "id" | "provider" | "secretId" | "baseUrl" | "extraHeaders"
  >,
): Promise<void> {
  let secretValue: string | null = null;
  if (apiKey.secretId) {
    secretValue = (await getSecretValueForLlmProviderApiKey(apiKey.secretId)) as
      | string
      | null;
  }

  if (
    !secretValue &&
    !isProviderApiKeyOptional({
      provider: apiKey.provider,
      azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
      anthropicKeylessAuthEnabled: isAnthropicKeylessAuthEnabled(),
    })
  ) {
    if (apiKey.secretId) {
      logger.warn(
        { apiKeyId: apiKey.id, provider: apiKey.provider },
        "No secret value for API key, skipping sync",
      );
    }
    throw new Error("No credential is configured");
  }

  try {
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: apiKey.provider,
      apiKeyValue: secretValue ?? "",
      baseUrl: apiKey.baseUrl,
      extraHeaders: apiKey.extraHeaders,
    });
  } catch (error) {
    logger.error(
      {
        apiKeyId: apiKey.id,
        provider: apiKey.provider,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "Failed to sync models for API key",
    );
    throw error;
  }
}

function shouldHandleWithSystemKeySync(apiKey: {
  provider: string;
  isSystem: boolean;
}): boolean {
  if (!apiKey.isSystem) {
    return false;
  }

  if (apiKey.provider === "gemini") {
    return isVertexAiEnabled();
  }

  if (apiKey.provider === "bedrock") {
    return isBedrockIamAuthEnabled();
  }

  return false;
}
