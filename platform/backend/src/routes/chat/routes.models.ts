import {
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  RouteId,
  SupportedProvidersSchema,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { modelsDevClient } from "@/clients/models-dev-client";
import logger from "@/logging";
import {
  ApiKeyModelModel,
  ChatApiKeyModel,
  ModelModel,
  TeamModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import {
  ApiError,
  constructResponseSchema,
  ModelCapabilitiesSchema,
  ModelWithApiKeysSchema,
  PatchModelBodySchema,
  SelectModelSchema,
  UuidIdSchema,
} from "@/types";

const ChatModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: SupportedProvidersSchema,
  createdAt: z.string().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  isBest: z.boolean().optional(),
  isFastest: z.boolean().optional(),
});

const chatModelsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/chat/models",
    {
      schema: {
        operationId: RouteId.GetChatModels,
        description:
          "Get available LLM models from all configured providers. Models are fetched directly from provider APIs. Includes model capabilities (context length, modalities, tool calling support) when available.",
        tags: ["Chat"],
        querystring: z.object({
          provider: SupportedProvidersSchema.optional(),
          apiKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(z.array(ChatModelSchema)),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      const { provider, apiKeyId } = query;

      modelsDevClient.syncIfNeeded();

      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const apiKeys = await ChatApiKeyModel.getAvailableKeysForUser(
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
      const dbModels = await ApiKeyModelModel.getModelsForApiKeyIds(apiKeyIds);

      logger.info(
        {
          organizationId,
          provider,
          apiKeyIds,
          modelCount: dbModels.length,
        },
        "Models fetched from database",
      );

      const filteredModels = provider
        ? dbModels.filter(({ model }) => model.provider === provider)
        : dbModels;

      const models = filteredModels
        .filter(({ model }) => ModelModel.supportsTextChat(model))
        .map(({ model, isBest, isFastest }) => ({
          id: model.modelId,
          displayName: model.description || model.modelId,
          provider: model.provider,
          capabilities: ModelModel.toCapabilities(model),
          isBest,
          isFastest,
        }));

      logger.info(
        { organizationId, provider, totalModels: models.length },
        "Returning chat models from database",
      );

      return reply.send(models);
    },
  );

  fastify.post(
    "/api/chat/models/sync",
    {
      schema: {
        operationId: RouteId.SyncChatModels,
        description:
          "Sync models from providers for all API keys and store them in the database",
        tags: ["Chat"],
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
    "/api/models",
    {
      schema: {
        operationId: RouteId.GetModelsWithApiKeys,
        description:
          "Get all models with their linked API keys. Returns models from the database with information about which API keys provide access to them.",
        tags: ["Models"],
        response: constructResponseSchema(z.array(ModelWithApiKeysSchema)),
      },
    },
    async (_, reply) => {
      const modelsWithApiKeys =
        await ApiKeyModelModel.getAllModelsWithApiKeys();

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
    "/api/models/:id",
    {
      schema: {
        operationId: RouteId.UpdateModel,
        description:
          "Update model details including custom pricing and modalities.",
        tags: ["Models"],
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

export default chatModelsRoutes;

export async function syncModelsForVisibleApiKeys(params: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { organizationId, userId } = params;
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const apiKeys = await ChatApiKeyModel.getAvailableKeysForUser(
    organizationId,
    userId,
    userTeamIds,
  );

  await Promise.all(
    apiKeys.map(async (apiKey) => {
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
