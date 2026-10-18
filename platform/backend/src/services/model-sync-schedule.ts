import {
  isProviderApiKeyOptional,
  type SupportedProvider,
  TimeInMs,
} from "@archestra/shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import logger from "@/logging";
import { LlmProviderApiKeyModel, TeamModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import type { LlmProviderApiKeyForModelSync } from "@/types";
import { mapWithConcurrency } from "@/utils/concurrency";

// ===== Public API =====

/**
 * One tick of the `llm_model_sync` periodic task: refresh models.dev metadata
 * when it is due and, alongside it, re-sync the API keys (in any organization)
 * whose models are older than their provider's TTL, at most `maxKeys` of them,
 * never-synced keys first, then the oldest syncs. The rest wait for the next
 * tick. Each key is marked in the shared cache right before its sync, so a key
 * that fails or lists no models is tried at most once per TTL across all pods,
 * and a tick that dies midway leaves the keys it never reached unmarked.
 */
export async function syncDueModels(params?: {
  maxKeys?: number;
}): Promise<void> {
  // models.dev only enriches metadata: a slow or failing fetch must not hold
  // up the key syncs, so the two run side by side.
  const [metadataSync, keySync] = await Promise.allSettled([
    modelsDevClient.syncIfNeeded(),
    syncDueApiKeys(params?.maxKeys ?? MAX_KEYS_PER_TICK),
  ]);
  // Per-key failures are handled inside; this is the key lookup itself
  // failing. Either outcome fails the tick once the key syncs are done, so
  // the task queue records it; the periodic task still runs next interval.
  const metadataError =
    metadataSync.status === "rejected"
      ? new Error("models.dev metadata sync failed", {
          cause: metadataSync.reason,
        })
      : null;
  if (keySync.status === "rejected") {
    throw metadataError
      ? new AggregateError(
          [keySync.reason, metadataError],
          "Model sync failed: the due-key lookup and models.dev",
        )
      : keySync.reason;
  }
  if (metadataError) throw metadataError;
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
          if (systemFailures.includes(apiKey.provider))
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

/** Keeps one tick short; keys past the cap go next tick. */
const MAX_KEYS_PER_TICK = 100;

function modelSyncTtl(provider: SupportedProvider): number {
  return MODEL_SYNC_TTL_BY_PROVIDER[provider] ?? DEFAULT_MODEL_SYNC_TTL_MS;
}

async function syncDueApiKeys(maxKeys: number): Promise<void> {
  const dueKeys = await LlmProviderApiKeyModel.findDueForModelSync({
    now: new Date(),
    ttlMsByProvider: MODEL_SYNC_TTL_BY_PROVIDER,
    defaultTtlMs: DEFAULT_MODEL_SYNC_TTL_MS,
    attemptMarkerPrefix: CacheKey.LlmModelSyncAttempt,
    limit: maxKeys,
  });
  if (dueKeys.length === 0) {
    return;
  }

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
 * An attempt within the TTL settles the key whatever its outcome: a failed
 * sync leaves the links as they were, and a key that lists no models has none,
 * so without the marker those keys would be fetched on every tick. Written
 * before the sync, so the marker never outlives the links the sync writes.
 * A failed write is logged and the sync still runs: the worst case is one
 * more attempt next tick.
 */
async function markSyncAttempt(
  apiKey: Pick<LlmProviderApiKeyForModelSync, "id" | "provider">,
): Promise<void> {
  try {
    await cacheManager.set(
      `${CacheKey.LlmModelSyncAttempt}-${apiKey.id}`,
      true,
      modelSyncTtl(apiKey.provider),
    );
  } catch {
    logger.warn(
      { apiKeyId: apiKey.id },
      "Could not record LLM model sync attempt",
    );
  }
}

async function syncOneKey(
  apiKey: LlmProviderApiKeyForModelSync,
): Promise<SyncOutcome> {
  await markSyncAttempt(apiKey);
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
  await Promise.all(keys.map(markSyncAttempt));
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
