import type { IncomingHttpHeaders } from "node:http";
import {
  isProviderApiKeyOptional,
  RouteId,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { capitalize } from "lodash-es";
import { z } from "zod";
import { hasPermission, userHasPermission } from "@/auth";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import {
  type BedrockSigV4Credentials,
  encodeBedrockSigV4Marker,
} from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import logger from "@/logging";
import {
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
  TeamModel,
  VirtualApiKeyModel,
} from "@/models";
import { testProviderApiKey } from "@/routes/chat/model-fetchers/registry";
import {
  assertByosEnabled,
  getSecretValueForLlmProviderApiKey,
  isByosEnabled,
  secretManager,
} from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import {
  ApiError,
  constructResponseSchema,
  LlmProviderApiKeyWithScopeInfoSchema,
  type ResourceVisibilityScope,
  ResourceVisibilityScopeSchema,
  SelectLlmProviderApiKeySchema,
  type SelectSecret,
} from "@/types";

async function testApiKeyOrThrow(
  provider: SupportedProvider,
  apiKey: string,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<void> {
  try {
    await testProviderApiKey(provider, apiKey, baseUrl, extraHeaders);
  } catch (error) {
    throw new ApiError(
      400,
      `Invalid API key: Failed to connect to ${capitalize(provider)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const llmProviderApiKeyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // List all visible LLM provider API keys for the user
  fastify.get(
    "/api/llm-provider-api-keys",
    {
      schema: {
        operationId: RouteId.GetLlmProviderApiKeys,
        description:
          "Get all LLM provider API keys visible to the current user based on scope access",
        tags: ["LLM Provider API Keys"],
        querystring: z.object({
          search: z.string().trim().min(1).optional(),
          provider: SupportedProvidersSchema.optional(),
        }),
        response: constructResponseSchema(
          z.array(LlmProviderApiKeyWithScopeInfoSchema),
        ),
      },
    },
    async ({ organizationId, user, query }, reply) => {
      // Get user's team IDs
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      const isLlmProviderApiKeyAdmin = await userHasPermission(
        user.id,
        organizationId,
        "llmProviderApiKey",
        "admin",
      );

      const apiKeys = await LlmProviderApiKeyModel.getVisibleKeys(
        organizationId,
        user.id,
        userTeamIds,
        isLlmProviderApiKeyAdmin,
        {
          search: query.search,
          provider: query.provider,
        },
      );
      return reply.send(apiKeys);
    },
  );

  // Get available API keys for LLM-powered features
  fastify.get(
    "/api/llm-provider-api-keys/available",
    {
      schema: {
        operationId: RouteId.GetAvailableLlmProviderApiKeys,
        description:
          "Get LLM provider API keys available for the current user to use",
        tags: ["LLM Provider API Keys"],
        querystring: z.object({
          provider: SupportedProvidersSchema.optional(),
          /** Include a specific key by ID even if user doesn't have direct access (e.g. agent's configured key) */
          includeKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(
          z.array(LlmProviderApiKeyWithScopeInfoSchema),
        ),
      },
    },
    async ({ organizationId, user, query }, reply) => {
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      const apiKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        organizationId,
        user.id,
        userTeamIds,
        query.provider,
      );

      // If includeKeyId is provided and not already in results, fetch it separately
      if (
        query.includeKeyId &&
        !apiKeys.some((k) => k.id === query.includeKeyId)
      ) {
        const agentKey = await LlmProviderApiKeyModel.findById(
          query.includeKeyId,
        );
        if (agentKey && agentKey.organizationId === organizationId) {
          apiKeys.push({
            ...agentKey,
            teamName: null,
            userName: null,
            isAgentKey: true,
          });
        }
      }

      const bestModelsByApiKeyId =
        await LlmProviderApiKeyModelLinkModel.getBestModelsForApiKeys(
          apiKeys.map((key) => key.id),
        );

      const apiKeysWithBestModel = apiKeys.map((key) => ({
        ...key,
        bestModelId: bestModelsByApiKeyId.get(key.id)?.modelId ?? null,
      }));

      return reply.send(apiKeysWithBestModel);
    },
  );

  // Create a new LLM provider API key
  fastify.post(
    "/api/llm-provider-api-keys",
    {
      schema: {
        operationId: RouteId.CreateLlmProviderApiKey,
        description:
          "Create a new LLM provider API key with specified visibility",
        tags: ["LLM Provider API Keys"],
        body: z
          .object({
            name: z.string().min(1, "Name is required"),
            provider: SupportedProvidersSchema,
            apiKey: z.string().min(1).optional(),
            baseUrl: z.string().url().nullable().optional(),
            extraHeaders: z
              .record(z.string(), z.string())
              .nullable()
              .optional(),
            scope: ResourceVisibilityScopeSchema.default("personal"),
            teamId: z.string().optional(),
            isPrimary: z.boolean().optional(),
            vaultSecretPath: z.string().min(1).optional(),
            vaultSecretKey: z.string().min(1).optional(),
            /** Bedrock-only: AWS access key ID for SigV4 auth */
            awsAccessKeyId: z.string().min(1).optional(),
            /** Bedrock-only: AWS secret access key for SigV4 auth */
            awsSecretAccessKey: z.string().min(1).optional(),
            /** Bedrock-only: optional AWS session token for STS/temporary creds */
            awsSessionToken: z.string().min(1).optional(),
          })
          .refine(
            (data) => {
              const hasSigV4 = data.awsAccessKeyId && data.awsSecretAccessKey;
              if (hasSigV4) return data.provider === "bedrock";
              if (isByosEnabled()) {
                return data.vaultSecretPath && data.vaultSecretKey;
              }
              return (
                isProviderApiKeyOptional({
                  provider: data.provider,
                  azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
                }) || data.apiKey
              );
            },
            {
              message:
                "Either apiKey, both vaultSecretPath and vaultSecretKey, or AWS SigV4 credentials (Bedrock only) must be provided",
            },
          ),
        response: constructResponseSchema(SelectLlmProviderApiKeySchema),
      },
    },
    async ({ body, organizationId, user, headers }, reply) => {
      // Prevent creating Gemini API keys when Vertex AI is enabled
      validateProviderAllowed(body.provider);

      // Validate scope/teamId combination and authorization
      await validateScopeAndAuthorization({
        scope: body.scope,
        teamId: body.teamId,
        userId: user.id,
        organizationId,
        headers,
      });

      let secret: SelectSecret | null = null;
      let actualApiKeyValue: string | null = null;

      // Bedrock SigV4: store credentials as JSON in the secret payload, then
      // test using the marker-encoded form.
      if (body.awsAccessKeyId && body.awsSecretAccessKey) {
        if (body.provider !== "bedrock") {
          throw new ApiError(
            400,
            "AWS SigV4 credentials are only supported for the Bedrock provider",
          );
        }
        const sigV4: BedrockSigV4Credentials = {
          accessKeyId: body.awsAccessKeyId,
          secretAccessKey: body.awsSecretAccessKey,
          sessionToken: body.awsSessionToken,
        };
        actualApiKeyValue = encodeBedrockSigV4Marker(sigV4);
        await testApiKeyOrThrow(
          body.provider,
          actualApiKeyValue,
          body.baseUrl,
          body.extraHeaders,
        );
        secret = await secretManager().createSecret(
          {
            accessKeyId: sigV4.accessKeyId,
            secretAccessKey: sigV4.secretAccessKey,
            ...(sigV4.sessionToken ? { sessionToken: sigV4.sessionToken } : {}),
          },
          getChatApiKeySecretName({
            scope: body.scope,
            teamId: body.teamId ?? null,
            userId: user.id,
          }),
        );
      } else if (isByosEnabled()) {
        if (!body.vaultSecretPath || !body.vaultSecretKey) {
          throw new ApiError(400, "Vault secret path and key are required");
        }
        const vaultReference = `${body.vaultSecretPath}#${body.vaultSecretKey}`;
        // first, get secret from vault path and key
        const manager = assertByosEnabled();
        const vaultData = await manager.getSecretFromPath(body.vaultSecretPath);
        actualApiKeyValue = vaultData[body.vaultSecretKey];

        if (!actualApiKeyValue) {
          throw new ApiError(
            400,
            `API key not found in Vault secret at path "${body.vaultSecretPath}" with key "${body.vaultSecretKey}"`,
          );
        }
        // then test the API key
        await testApiKeyOrThrow(
          body.provider,
          actualApiKeyValue,
          body.baseUrl,
          body.extraHeaders,
        );
        // then create the secret
        secret = await secretManager().createSecret(
          { apiKey: vaultReference },
          getChatApiKeySecretName({
            scope: body.scope,
            teamId: body.teamId ?? null,
            userId: user.id,
          }),
        );
      } else if (body.apiKey) {
        // When readonly_vault is disabled
        actualApiKeyValue = body.apiKey;
        // Test the API key before saving
        await testApiKeyOrThrow(
          body.provider,
          actualApiKeyValue,
          body.baseUrl,
          body.extraHeaders,
        );

        secret = await secretManager().createSecret(
          { apiKey: actualApiKeyValue },
          getChatApiKeySecretName({
            scope: body.scope,
            teamId: body.teamId ?? null,
            userId: user.id,
          }),
        );
      }

      if (
        !secret &&
        !isProviderApiKeyOptional({
          provider: body.provider,
          azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
        })
      ) {
        throw new ApiError(
          400,
          "Secret creation failed, cannot create API key",
        );
      }

      // Create the API key record
      const createdApiKey = await LlmProviderApiKeyModel.create({
        organizationId,
        name: body.name,
        provider: body.provider,
        secretId: secret?.id ?? null,
        baseUrl: body.baseUrl ?? null,
        extraHeaders: body.extraHeaders ?? null,
        scope: body.scope,
        userId: body.scope === "personal" ? user.id : null,
        teamId: body.scope === "team" ? body.teamId : null,
        isPrimary: body.isPrimary ?? false,
      });

      // Sync models for the new API key before returning so the frontend
      // can immediately show available models after creation.
      // For optional-key providers (Ollama, vLLM), sync even without an API key value.
      const canSync =
        actualApiKeyValue ||
        isProviderApiKeyOptional({
          provider: body.provider,
          azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
        });
      if (canSync) {
        try {
          await modelSyncService.syncModelsForApiKey({
            apiKeyId: createdApiKey.id,
            provider: body.provider,
            apiKeyValue: actualApiKeyValue ?? "",
            baseUrl: body.baseUrl,
            extraHeaders: body.extraHeaders ?? null,
          });
        } catch (error) {
          // Model sync failure shouldn't block API key creation
          logger.error(
            {
              apiKeyId: createdApiKey.id,
              provider: body.provider,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
            "Failed to sync models for new API key",
          );
        }
      }

      return reply.send(createdApiKey);
    },
  );

  // Get a single LLM provider API key
  fastify.get(
    "/api/llm-provider-api-keys/:id",
    {
      schema: {
        operationId: RouteId.GetLlmProviderApiKey,
        description: "Get a specific LLM provider API key",
        tags: ["LLM Provider API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(LlmProviderApiKeyWithScopeInfoSchema),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const apiKey = await LlmProviderApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      // Check visibility based on scope
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const isLlmProviderApiKeyAdmin = await userHasPermission(
        user.id,
        organizationId,
        "llmProviderApiKey",
        "admin",
      );

      // Personal keys: only visible to owner
      if (apiKey.scope === "personal" && apiKey.userId !== user.id) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      // Team keys: visible to team members or admins
      if (apiKey.scope === "team" && !isLlmProviderApiKeyAdmin) {
        if (!apiKey.teamId || !userTeamIds.includes(apiKey.teamId)) {
          throw new ApiError(404, "LLM provider API key not found");
        }
      }

      return reply.send(apiKey);
    },
  );

  // Update an LLM provider API key
  fastify.patch(
    "/api/llm-provider-api-keys/:id",
    {
      schema: {
        operationId: RouteId.UpdateLlmProviderApiKey,
        description:
          "Update an LLM provider API key (name, API key value, visibility, or team)",
        tags: ["LLM Provider API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z
          .object({
            name: z.string().min(1).optional(),
            apiKey: z.string().min(1).optional(),
            baseUrl: z.string().url().nullable().optional(),
            extraHeaders: z
              .record(z.string(), z.string())
              .nullable()
              .optional(),
            scope: ResourceVisibilityScopeSchema.optional(),
            teamId: z.string().uuid().nullable().optional(),
            isPrimary: z.boolean().optional(),
            vaultSecretPath: z.string().min(1).optional(),
            vaultSecretKey: z.string().min(1).optional(),
            /** Bedrock-only: AWS access key ID for SigV4 auth */
            awsAccessKeyId: z.string().min(1).optional(),
            /** Bedrock-only: AWS secret access key for SigV4 auth */
            awsSecretAccessKey: z.string().min(1).optional(),
            /** Bedrock-only: optional AWS session token for STS/temporary creds */
            awsSessionToken: z.string().min(1).optional(),
          })
          .refine(
            (data) => {
              const hasSigV4 = data.awsAccessKeyId && data.awsSecretAccessKey;
              if (hasSigV4) return true;
              // If no key-related fields are provided, that's fine (updating other fields)
              if (
                !data.apiKey &&
                !data.vaultSecretPath &&
                !data.vaultSecretKey
              ) {
                return true;
              }
              // If apiKey is provided, that's always valid
              if (data.apiKey) {
                return true;
              }
              // If BYOS is enabled and vault fields are provided, both must be present
              if (isByosEnabled()) {
                return data.vaultSecretPath && data.vaultSecretKey;
              }
              return false;
            },
            {
              message:
                "Either apiKey, both vaultSecretPath and vaultSecretKey, or AWS SigV4 credentials must be provided",
            },
          ),
        response: constructResponseSchema(SelectLlmProviderApiKeySchema),
      },
    },
    async ({ params, body, organizationId, user, headers }, reply) => {
      const apiKeyFromDB = await LlmProviderApiKeyModel.findById(params.id);

      if (!apiKeyFromDB || apiKeyFromDB.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      // Check authorization based on current scope
      await authorizeApiKeyAccess({
        apiKey: apiKeyFromDB,
        userId: user.id,
        organizationId,
        headers,
      });

      // If scope is changing, validate the new scope
      const newScope = body.scope ?? apiKeyFromDB.scope;
      const newTeamId =
        body.teamId !== undefined ? body.teamId : apiKeyFromDB.teamId;
      let newSecretId: string | null = null;

      if (body.scope !== undefined || body.teamId !== undefined) {
        await validateScopeAndAuthorization({
          scope: newScope,
          teamId: newTeamId,
          userId: user.id,
          organizationId,
          headers,
        });
      }

      const sigV4FromBody =
        body.awsAccessKeyId && body.awsSecretAccessKey
          ? {
              accessKeyId: body.awsAccessKeyId,
              secretAccessKey: body.awsSecretAccessKey,
              sessionToken: body.awsSessionToken,
            }
          : null;
      const hasSigV4Update = sigV4FromBody !== null;
      if (hasSigV4Update && apiKeyFromDB.provider !== "bedrock") {
        throw new ApiError(
          400,
          "AWS SigV4 credentials are only supported for the Bedrock provider",
        );
      }

      // Update the secret if a new API key is provided (via direct value, vault reference, or SigV4 credentials)
      if (
        body.apiKey ||
        (body.vaultSecretPath && body.vaultSecretKey) ||
        hasSigV4Update
      ) {
        let secretPayload: Record<string, string>;
        let testValue: string;

        if (sigV4FromBody) {
          const sigV4: BedrockSigV4Credentials = sigV4FromBody;
          secretPayload = {
            accessKeyId: sigV4.accessKeyId,
            secretAccessKey: sigV4.secretAccessKey,
            ...(sigV4.sessionToken ? { sessionToken: sigV4.sessionToken } : {}),
          };
          testValue = encodeBedrockSigV4Marker(sigV4);
        } else if (
          isByosEnabled() &&
          body.vaultSecretPath &&
          body.vaultSecretKey
        ) {
          // Get secret from vault
          const manager = assertByosEnabled();
          const vaultData = await manager.getSecretFromPath(
            body.vaultSecretPath,
          );
          const apiKeyValue = vaultData[body.vaultSecretKey];
          if (!apiKeyValue) {
            throw new ApiError(
              400,
              `API key not found in Vault secret at path "${body.vaultSecretPath}" with key "${body.vaultSecretKey}"`,
            );
          }
          const vaultReference = `${body.vaultSecretPath}#${body.vaultSecretKey}`;
          secretPayload = { apiKey: vaultReference };
          testValue = apiKeyValue;
        } else if (body.apiKey) {
          // Use direct API key value
          secretPayload = { apiKey: body.apiKey };
          testValue = body.apiKey;
        } else {
          // This shouldn't happen due to refine, but TypeScript needs this
          throw new ApiError(400, "API key or vault reference is required");
        }

        // Test the API key before saving
        // Use user-provided baseUrl/extraHeaders if present, otherwise fall
        // back to what's stored on the API key record.
        const testBaseUrl =
          body.baseUrl !== undefined ? body.baseUrl : apiKeyFromDB.baseUrl;
        const testExtraHeaders =
          body.extraHeaders !== undefined
            ? body.extraHeaders
            : apiKeyFromDB.extraHeaders;
        await testApiKeyOrThrow(
          apiKeyFromDB.provider,
          testValue,
          testBaseUrl,
          testExtraHeaders,
        );

        // Update or create the secret
        if (apiKeyFromDB.secretId) {
          await secretManager().updateSecret(
            apiKeyFromDB.secretId,
            secretPayload,
          );
        } else {
          const secret = await secretManager().createSecret(
            secretPayload,
            getChatApiKeySecretName({
              scope: newScope,
              teamId: newTeamId,
              userId: user.id,
            }),
          );
          newSecretId = secret.id;
        }
      } else if (
        body.baseUrl !== undefined ||
        body.extraHeaders !== undefined
      ) {
        // If baseUrl/extraHeaders are being updated without a new API key,
        // we need to re-test using the existing API key.
        let apiKeyValue: string | undefined;

        if (apiKeyFromDB.secretId) {
          apiKeyValue = await getSecretValueForLlmProviderApiKey(
            apiKeyFromDB.secretId,
          );
        }
        const testBaseUrl =
          body.baseUrl !== undefined ? body.baseUrl : apiKeyFromDB.baseUrl;
        const testExtraHeaders =
          body.extraHeaders !== undefined
            ? body.extraHeaders
            : apiKeyFromDB.extraHeaders;
        if (apiKeyValue) {
          await testApiKeyOrThrow(
            apiKeyFromDB.provider,
            apiKeyValue,
            testBaseUrl,
            testExtraHeaders,
          );
        } else if (
          !isProviderApiKeyOptional({
            provider: apiKeyFromDB.provider,
            azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
          })
        ) {
          throw new ApiError(
            400,
            "Cannot update Base URL or extra headers without existing API key",
          );
        }
      }

      // Build update object
      const updateData: Partial<{
        name: string;
        baseUrl: string | null;
        extraHeaders: Record<string, string> | null;
        scope: ResourceVisibilityScope;
        userId: string | null;
        teamId: string | null;
        secretId: string | null;
        isPrimary: boolean;
      }> = {};

      if (body.name) {
        updateData.name = body.name;
      }

      if (body.baseUrl !== undefined) {
        updateData.baseUrl = body.baseUrl;
      }

      if (body.extraHeaders !== undefined) {
        updateData.extraHeaders = body.extraHeaders;
      }

      if (body.isPrimary !== undefined) {
        updateData.isPrimary = body.isPrimary;
      }

      if (newSecretId) {
        updateData.secretId = newSecretId;
      }

      if (body.scope !== undefined) {
        updateData.scope = body.scope;
        // Set userId/teamId based on new scope
        updateData.userId = body.scope === "personal" ? user.id : null;
        updateData.teamId = body.scope === "team" ? newTeamId : null;
      } else if (body.teamId !== undefined && apiKeyFromDB.scope === "team") {
        // Only update teamId if scope is team and not changing
        updateData.teamId = body.teamId;
      }

      if (Object.keys(updateData).length > 0) {
        await LlmProviderApiKeyModel.update(params.id, updateData);
      }

      const updated = await LlmProviderApiKeyModel.findById(params.id);
      if (!updated) {
        throw new ApiError(404, "LLM provider API key not found");
      }
      return reply.send(updated);
    },
  );

  // Delete an LLM provider API key
  fastify.delete(
    "/api/llm-provider-api-keys/:id",
    {
      schema: {
        operationId: RouteId.DeleteLlmProviderApiKey,
        description: "Delete an LLM provider API key",
        tags: ["LLM Provider API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId, user, headers }, reply) => {
      const apiKey = await LlmProviderApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      // Check authorization based on scope
      await authorizeApiKeyAccess({
        apiKey,
        userId: user.id,
        organizationId,
        headers,
      });

      // Prevent deletion if the key is used for knowledge base embedding or reranking
      const org = await OrganizationModel.getById(organizationId);
      if (org) {
        const usages: string[] = [];
        if (org.embeddingChatApiKeyId === params.id) usages.push("embedding");
        if (org.rerankerChatApiKeyId === params.id) usages.push("reranking");
        if (usages.length > 0) {
          throw new ApiError(
            400,
            `This API key is used for knowledge base ${usages.join(" and ")}. Remove it from Settings > Knowledge before deleting.`,
          );
        }
      }

      const virtualKeys = await VirtualApiKeyModel.findByProviderApiKeyId({
        providerApiKeyId: params.id,
        organizationId,
        userId: user.id,
        userTeamIds: await TeamModel.getUserTeamIds(user.id),
        isAdmin: true,
      });
      if (virtualKeys.length > 0) {
        throw new ApiError(
          400,
          "This API key is mapped to one or more virtual API keys. Remove those mappings before deleting it.",
        );
      }

      const oauthClients = await LlmOauthClientModel.findByProviderApiKeyId({
        providerApiKeyId: params.id,
        organizationId,
      });
      if (oauthClients.length > 0) {
        throw new ApiError(
          400,
          "This API key is mapped to one or more OAuth clients. Remove those mappings before deleting it.",
        );
      }

      // Delete the parent key's associated secret
      if (apiKey.secretId) {
        await secretManager().deleteSecret(apiKey.secretId);
      }

      await LlmProviderApiKeyModel.delete(params.id);

      // Clean up orphaned models that lost their last API key link.
      // Models discovered via LLM Proxy are preserved for custom pricing.
      const deletedCount = await ModelModel.deleteOrphanedModels();
      if (deletedCount > 0) {
        logger.info(
          { deletedCount },
          "Cleaned up orphaned models after API key deletion",
        );
      }

      return reply.send({ success: true });
    },
  );
};

/**
 * Validates scope/teamId combination and checks user authorization for the scope.
 * Used for both creating and updating API keys.
 */
async function validateScopeAndAuthorization(params: {
  scope: ResourceVisibilityScope;
  teamId: string | null | undefined;
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
}): Promise<void> {
  const { scope, teamId, userId, organizationId, headers } = params;

  // Validate scope-specific requirements
  if (scope === "team" && !teamId) {
    throw new ApiError(400, "teamId is required for team-scoped API keys");
  }

  if (scope === "personal" && teamId) {
    throw new ApiError(
      400,
      "teamId should not be provided for personal-scoped API keys",
    );
  }

  if (scope === "org" && teamId) {
    throw new ApiError(
      400,
      "teamId should not be provided for org-wide API keys",
    );
  }

  // For team-scoped keys, verify user has access to the team
  if (scope === "team" && teamId) {
    const { success: isTeamAdmin } = await hasPermission(
      { team: ["admin"] },
      headers,
    );

    if (!isTeamAdmin) {
      const isUserInTeam = await TeamModel.isUserInTeam(teamId, userId);
      if (!isUserInTeam) {
        throw new ApiError(
          403,
          "You must be a member of the team to use this scope",
        );
      }
    }
  }

  // For org-wide keys, require the dedicated API-key admin permission
  if (scope === "org") {
    const isLlmProviderApiKeyAdmin = await userHasPermission(
      userId,
      organizationId,
      "llmProviderApiKey",
      "admin",
    );
    if (!isLlmProviderApiKeyAdmin) {
      throw new ApiError(
        403,
        "Only llmProviderApiKey admins can use organization-wide scope",
      );
    }
  }
}

/**
 * Helper to check if a user is authorized to modify an API key based on scope
 */
async function authorizeApiKeyAccess(params: {
  apiKey: { scope: string; userId: string | null; teamId: string | null };
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
}): Promise<void> {
  const { apiKey, userId, organizationId, headers } = params;

  // Personal keys: only owner can modify
  if (apiKey.scope === "personal") {
    if (apiKey.userId !== userId) {
      throw new ApiError(403, "You can only modify your own personal API keys");
    }
    return;
  }

  // Team keys: require team membership or team admin
  if (apiKey.scope === "team") {
    const { success: isTeamAdmin } = await hasPermission(
      { team: ["admin"] },
      headers,
    );

    if (!isTeamAdmin && apiKey.teamId) {
      const isUserInTeam = await TeamModel.isUserInTeam(apiKey.teamId, userId);
      if (!isUserInTeam) {
        throw new ApiError(
          403,
          "You can only modify team API keys for teams you are a member of",
        );
      }
    }
    return;
  }

  // Org-wide keys: require the dedicated API-key admin permission
  if (apiKey.scope === "org") {
    const isLlmProviderApiKeyAdmin = await userHasPermission(
      userId,
      organizationId,
      "llmProviderApiKey",
      "admin",
    );
    if (!isLlmProviderApiKeyAdmin) {
      throw new ApiError(
        403,
        "Only llmProviderApiKey admins can modify organization-wide API keys",
      );
    }
    return;
  }
}

function getChatApiKeySecretName({
  scope,
  teamId,
  userId,
}: {
  scope: ResourceVisibilityScope;
  teamId: string | null;
  userId: string | null;
}): string {
  if (scope === "personal") {
    return `chatapikey-personal-${userId}`;
  }
  if (scope === "team") {
    return `chatapikey-team-${teamId}`;
  }
  return `chatapikey-org`;
}

/**
 * Validates that the provider is allowed based on current configuration.
 * Throws ApiError if Gemini provider is requested while Vertex AI is enabled.
 */
export function validateProviderAllowed(provider: SupportedProvider): void {
  if (provider === "gemini" && isVertexAiEnabled()) {
    throw new ApiError(
      400,
      "Cannot create Gemini API key: Vertex AI is configured. Gemini uses Application Default Credentials instead of API keys.",
    );
  }
}

export default llmProviderApiKeyRoutes;
