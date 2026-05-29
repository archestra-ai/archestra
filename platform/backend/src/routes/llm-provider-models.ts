import {
  EmbeddingDimensionsSchema,
  isFreeModel,
  isProviderApiKeyOptional,
  LAZY_MODEL_SYNC_STATUS_HEADER,
  LAZY_MODEL_SYNC_STATUS_PENDING,
  RouteId,
  type SupportedProvider,
  SupportedProvidersSchema,
  TimeInMs,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LRUCacheManager } from "@/cache-manager";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  type ModelSyncState,
  TeamModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import {
  ApiError,
  constructResponseSchema,
  type LlmProviderApiKeyWithScopeInfo,
  ModelCapabilitiesSchema,
  ModelWithApiKeysSchema,
  PatchModelBodySchema,
  SelectModelSchema,
  UuidIdSchema,
} from "@/types";

const DEFAULT_LAZY_MODEL_SYNC_TTL_MS = TimeInMs.Day;
const LAZY_MODEL_SYNC_TTL_BY_PROVIDER: Partial<
  Record<SupportedProvider, number>
> = {
  openrouter: TimeInMs.Hour,
  ollama: 5 * TimeInMs.Minute,
  vllm: 5 * TimeInMs.Minute,
};

const lazyModelSyncsByApiKeyId = new Map<string, Promise<void>>();

/**
 * Negative cache marking API keys whose lazy sync was recently attempted (any
 * outcome). Keys that legitimately resolve zero models are otherwise classified
 * stale forever, re-triggering an upstream fetch on every request; this caps
 * the re-sync rate to the provider's TTL window. Per-pod by design — a fresh
 * pod re-attempting once per TTL is acceptable.
 */
const recentLazyModelSyncAttempts = new LRUCacheManager<true>({
  maxSize: 5000,
  defaultTtl: DEFAULT_LAZY_MODEL_SYNC_TTL_MS,
});

const LlmModelSchema = z.object({
  id: z.string(),
  /** The models.id UUID — used as the model_id FK on conversations/agents. */
  dbId: z.string(),
  displayName: z.string(),
  provider: SupportedProvidersSchema,
  createdAt: z.string().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  isBest: z.boolean().optional(),
  isFastest: z.boolean().optional(),
  /** True when the provider charges nothing for this model (both prices are zero). */
  isFree: z.boolean(),
  embeddingDimensions: EmbeddingDimensionsSchema.nullable().optional(),
});

const llmModelsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-models/available",
    {
      schema: {
        operationId: RouteId.GetLlmModels,
        description:
          "Get available LLM models from configured provider API keys. Models are fetched from the provider-backed catalog and include capabilities when available.",
        tags: ["LLM Models"],
        querystring: z.object({
          provider: SupportedProvidersSchema.optional(),
          apiKeyId: z.string().uuid().optional(),
          isEmbedding: z
            .string()
            .transform((v) => v === "true")
            .optional(),
        }),
        response: constructResponseSchema(z.array(LlmModelSchema)),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      const { provider, apiKeyId, isEmbedding } = query;

      modelsDevClient.syncIfNeeded();

      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const apiKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        organizationId,
        user.id,
        userTeamIds,
        provider,
      );

      logger.info(
        {
          organizationId,
          provider,
          apiKeyId,
          apiKeyCount: apiKeys.length,
          apiKeys: apiKeys.map((key) => ({
            id: key.id,
            name: key.name,
            provider: key.provider,
            isSystem: key.isSystem,
          })),
        },
        "Available API keys for user",
      );

      const accessibleKeyIds = apiKeys.map((key) => key.id);
      if (apiKeyId && !accessibleKeyIds.includes(apiKeyId)) {
        logger.warn(
          { apiKeyId, organizationId, userId: user.id },
          "Requested apiKeyId not found in user's accessible keys, falling back to all keys",
        );
      }

      const apiKeyIds =
        apiKeyId && accessibleKeyIds.includes(apiKeyId)
          ? [apiKeyId]
          : accessibleKeyIds;
      const modelQueryApiKeys = apiKeys.filter((apiKey) =>
        apiKeyIds.includes(apiKey.id),
      );

      try {
        const lazyModelSyncs = await triggerLazyModelSyncForStaleApiKeys({
          organizationId,
          apiKeys: modelQueryApiKeys,
        });
        if (lazyModelSyncs.length > 0) {
          reply.header(
            LAZY_MODEL_SYNC_STATUS_HEADER,
            LAZY_MODEL_SYNC_STATUS_PENDING,
          );
        }
      } catch (error) {
        logger.error(
          {
            organizationId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          "Failed to schedule lazy model sync",
        );
      }

      const dbModels =
        await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds(apiKeyIds);

      logger.info(
        {
          organizationId,
          provider,
          apiKeyIds,
          modelCount: dbModels.length,
        },
        "Models fetched from database",
      );

      let filteredModels = provider
        ? dbModels.filter(({ model }) => model.provider === provider)
        : dbModels;

      // Filter by embedding status if requested
      if (isEmbedding !== undefined) {
        filteredModels = filteredModels.filter(({ model }) =>
          isEmbedding
            ? model.embeddingDimensions !== null
            : model.embeddingDimensions === null,
        );
      }

      const models = filteredModels
        .filter(({ model }) =>
          isEmbedding ? true : ModelModel.supportsTextChat(model),
        )
        .map(({ model, isBest, isFastest }) => ({
          id: model.modelId,
          dbId: model.id,
          displayName: model.description || model.modelId,
          provider: model.provider,
          capabilities: ModelModel.toCapabilities(model),
          isBest,
          isFastest,
          isFree: isFreeModel(model),
          embeddingDimensions: model.embeddingDimensions,
        }));

      logger.info(
        { organizationId, provider, totalModels: models.length },
        "Returning available LLM models from database",
      );

      return reply.send(models);
    },
  );

  fastify.post(
    "/api/llm-models/sync",
    {
      schema: {
        operationId: RouteId.SyncLlmModels,
        description:
          "Sync models from providers for all visible API keys and store them in the database",
        tags: ["LLM Models"],
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, user }, reply) => {
      await syncModelsForVisibleApiKeys({ organizationId, userId: user.id });

      logger.info({ organizationId }, "Completed model sync for all API keys");

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/llm-models",
    {
      schema: {
        operationId: RouteId.GetModelsWithApiKeys,
        description:
          "Get all synced LLM models with their linked provider API keys.",
        tags: ["LLM Models"],
        response: constructResponseSchema(z.array(ModelWithApiKeysSchema)),
      },
    },
    async (_, reply) => {
      const modelsWithApiKeys =
        await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();

      const linkedModelIds = new Set(
        modelsWithApiKeys.map((item) => item.model.id),
      );
      const llmProxyModels = await ModelModel.findLlmProxyModels();
      const unlinkedLlmProxyModels = llmProxyModels.filter(
        (model) => !linkedModelIds.has(model.id),
      );

      const response = [
        ...modelsWithApiKeys.map(({ model, isFastest, isBest, apiKeys }) => {
          const pricing = ModelModel.toCapabilities(model);
          return {
            ...model,
            isFastest,
            isBest,
            apiKeys,
            pricePerMillionInput: pricing.pricePerMillionInput,
            pricePerMillionOutput: pricing.pricePerMillionOutput,
            isCustomPrice: pricing.isCustomPrice,
            priceSource: pricing.priceSource,
            isFree: isFreeModel(model),
          };
        }),
        ...unlinkedLlmProxyModels.map((model) => {
          const pricing = ModelModel.toCapabilities(model);
          return {
            ...model,
            isFastest: false,
            isBest: false,
            apiKeys: [],
            pricePerMillionInput: pricing.pricePerMillionInput,
            pricePerMillionOutput: pricing.pricePerMillionOutput,
            isCustomPrice: pricing.isCustomPrice,
            priceSource: pricing.priceSource,
            isFree: isFreeModel(model),
          };
        }),
      ];

      logger.debug(
        { modelCount: response.length },
        "Returning models with API keys",
      );

      return reply.send(response);
    },
  );

  fastify.patch(
    "/api/llm-models/:id",
    {
      schema: {
        operationId: RouteId.UpdateModel,
        description:
          "Update LLM model details including custom pricing and modalities.",
        tags: ["LLM Models"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: PatchModelBodySchema,
        response: constructResponseSchema(SelectModelSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const existing = await ModelModel.findById(id);
      if (!existing) {
        throw new ApiError(404, "Model not found");
      }

      const updated = await ModelModel.update(id, body);
      if (!updated) {
        throw new ApiError(500, "Failed to update model");
      }

      return reply.send(updated);
    },
  );
};

export default llmModelsRoutes;

export async function syncModelsForVisibleApiKeys(params: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { organizationId, userId } = params;
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const apiKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    organizationId,
    userId,
    userTeamIds,
  );

  if (apiKeys.some(shouldHandleWithSystemKeySync)) {
    await systemKeyManager.syncSystemKeys(organizationId);
  }

  await Promise.all(
    apiKeys
      .filter((apiKey) => !shouldHandleWithSystemKeySync(apiKey))
      .map((apiKey) => syncVisibleApiKeyModels({ apiKey, organizationId })),
  );
}

export async function triggerLazyModelSyncForStaleApiKeys(params: {
  organizationId: string;
  apiKeys: LlmProviderApiKeyWithScopeInfo[];
  now?: Date;
}): Promise<Array<Promise<void>>> {
  const staleApiKeys = await getStaleModelSyncApiKeys(params);
  const syncs = staleApiKeys.map((apiKey) =>
    scheduleLazyModelSyncForApiKey({
      apiKey,
      organizationId: params.organizationId,
    }),
  );

  if (syncs.length > 0) {
    logger.info(
      {
        organizationId: params.organizationId,
        apiKeyIds: staleApiKeys.map((apiKey) => apiKey.id),
      },
      "Scheduled lazy model sync for stale API keys",
    );
  }

  return syncs;
}

export async function getStaleModelSyncApiKeys(params: {
  apiKeys: LlmProviderApiKeyWithScopeInfo[];
  now?: Date;
}): Promise<LlmProviderApiKeyWithScopeInfo[]> {
  const { apiKeys, now = new Date() } = params;
  const syncStates =
    await LlmProviderApiKeyModelLinkModel.getModelSyncStatesForApiKeys(
      apiKeys.map((apiKey) => apiKey.id),
    );

  return apiKeys.filter((apiKey) =>
    isModelSyncStateStale({
      provider: apiKey.provider,
      syncState: syncStates.get(apiKey.id),
      recentlyAttempted: recentLazyModelSyncAttempts.get(apiKey.id) === true,
      now,
    }),
  );
}

export function isModelSyncStateStale(params: {
  provider: SupportedProvider;
  syncState?: Pick<ModelSyncState, "linkedModelCount" | "oldestLastSyncedAt">;
  /** Whether a lazy sync was attempted within this provider's TTL window. */
  recentlyAttempted?: boolean;
  now?: Date;
}): boolean {
  const {
    provider,
    syncState,
    recentlyAttempted = false,
    now = new Date(),
  } = params;

  // no usable linked models yet (unlinked key, empty provider, or failed sync):
  // re-sync unless we already attempted recently, else we'd hammer the provider.
  if (
    !syncState ||
    syncState.linkedModelCount === 0 ||
    !syncState.oldestLastSyncedAt
  ) {
    return !recentlyAttempted;
  }

  const ttl =
    LAZY_MODEL_SYNC_TTL_BY_PROVIDER[provider] ?? DEFAULT_LAZY_MODEL_SYNC_TTL_MS;
  return now.getTime() - syncState.oldestLastSyncedAt.getTime() >= ttl;
}

async function syncVisibleApiKeyModels(params: {
  apiKey: LlmProviderApiKeyWithScopeInfo;
  organizationId: string;
}): Promise<void> {
  const { apiKey, organizationId } = params;

  if (shouldHandleWithSystemKeySync(apiKey)) {
    await systemKeyManager.syncSystemKeys(organizationId);
    return;
  }

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
    })
  ) {
    if (apiKey.secretId) {
      logger.warn(
        { apiKeyId: apiKey.id, provider: apiKey.provider },
        "No secret value for API key, skipping sync",
      );
    }
    return;
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
  }
}

function scheduleLazyModelSyncForApiKey(params: {
  apiKey: LlmProviderApiKeyWithScopeInfo;
  organizationId: string;
}): Promise<void> {
  const { apiKey } = params;
  const inFlight = lazyModelSyncsByApiKeyId.get(apiKey.id);
  if (inFlight) {
    return inFlight;
  }

  const sync = syncVisibleApiKeyModels(params)
    .catch((error) => {
      logger.error(
        {
          apiKeyId: apiKey.id,
          provider: apiKey.provider,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Failed to lazily sync models for API key",
      );
    })
    .finally(() => {
      lazyModelSyncsByApiKeyId.delete(apiKey.id);
      // mark the attempt (success or failure) so a zero-model key isn't
      // re-synced on every request until the provider's TTL elapses.
      recentLazyModelSyncAttempts.set(
        apiKey.id,
        true,
        LAZY_MODEL_SYNC_TTL_BY_PROVIDER[apiKey.provider] ??
          DEFAULT_LAZY_MODEL_SYNC_TTL_MS,
      );
    });
  lazyModelSyncsByApiKeyId.set(apiKey.id, sync);
  return sync;
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
