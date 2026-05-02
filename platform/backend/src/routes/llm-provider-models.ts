import {
  EmbeddingDimensionsSchema,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  RouteId,
  SupportedProvidersSchema,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  TeamModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import {
  ApiError,
  constructResponseSchema,
  ModelCapabilitiesSchema,
  ModelWithApiKeysSchema,
  PatchModelBodySchema,
  SelectModelSchema,
  UuidIdSchema,
} from "@/types";

const LlmModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: SupportedProvidersSchema,
  createdAt: z.string().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  isBest: z.boolean().optional(),
  isFastest: z.boolean().optional(),
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
          displayName: model.description || model.modelId,
          provider: model.provider,
          capabilities: ModelModel.toCapabilities(model),
          isBest,
          isFastest,
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
      .map(async (apiKey) => {
        let secretValue: string | null = null;

        if (apiKey.secretId) {
          secretValue = (await getSecretValueForLlmProviderApiKey(
            apiKey.secretId,
          )) as string | null;
        }

        if (
          !secretValue &&
          !PROVIDERS_WITH_OPTIONAL_API_KEY.has(apiKey.provider)
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
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
            "Failed to sync models for API key",
          );
        }
      }),
  );
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
