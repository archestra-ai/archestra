import type { IncomingHttpHeaders } from "node:http";
import { PROVIDERS_WITH_OPTIONAL_API_KEY, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { capitalize } from "lodash-es";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import logger from "@/logging";
import { ApiKeyModelModel, ChatApiKeyModel, TeamModel } from "@/models";
import { testProviderApiKey } from "@/routes/chat/routes.models";
import {
  assertByosEnabled,
  isByosEnabled,
  secretManager,
} from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import {
  ApiError,
  ChatApiKeyScopeSchema,
  ChatApiKeyWithScopeInfoSchema,
  constructResponseSchema,
  SelectChatApiKeySchema,
  type SelectSecret,
  type SupportedChatProvider,
  SupportedChatProviderSchema,
} from "@/types";

const chatApiKeysRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // List all visible chat API keys for the user
  fastify.get(
    "/api/chat-api-keys",
    {
      schema: {
        operationId: RouteId.GetChatApiKeys,
        description:
          "Get all chat API keys visible to the current user based on scope access",
        tags: ["Chat API Keys"],
        response: constructResponseSchema(
          z.array(ChatApiKeyWithScopeInfoSchema),
        ),
      },
    },
    async ({ organizationId, user, headers }, reply) => {
      // Get user's team IDs
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      // Check if user is a profile admin
      const { success: isProfileAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const apiKeys = await ChatApiKeyModel.getVisibleKeys(
        organizationId,
        user.id,
        userTeamIds,
        isProfileAdmin,
      );
      return reply.send(apiKeys);
    },
  );

  // Get available API keys for chat (keys the user can use)
  fastify.get(
    "/api/chat-api-keys/available",
    {
      schema: {
        operationId: RouteId.GetAvailableChatApiKeys,
        description:
          "Get API keys available for the current user to use in chat",
        tags: ["Chat API Keys"],
        querystring: z.object({
          provider: SupportedChatProviderSchema.optional(),
          /** Include a specific key by ID even if user doesn't have direct access (e.g. agent's configured key) */
          includeKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(
          z.array(ChatApiKeyWithScopeInfoSchema),
        ),
      },
    },
    async ({ organizationId, user, query }, reply) => {
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      const apiKeys = await ChatApiKeyModel.getAvailableKeysForUser(
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
        const agentKey = await ChatApiKeyModel.findById(query.includeKeyId);
        if (agentKey && agentKey.organizationId === organizationId) {
          apiKeys.push({
            ...agentKey,
            teamName: null,
            userName: null,
            isAgentKey: true,
          });
        }
      }

      // Compute bestModelId for each key
      const apiKeysWithBestModel = await Promise.all(
        apiKeys.map(async (key) => {
          const bestModel = await ApiKeyModelModel.getBestModel(key.id);
          return {
            ...key,
            bestModelId: bestModel?.modelId ?? null,
          };
        }),
      );

      return reply.send(apiKeysWithBestModel);
    },
  );

  // Create a new chat API key
  fastify.post(
    "/api/chat-api-keys",
    {
      schema: {
        operationId: RouteId.CreateChatApiKey,
        description: "Create a new chat API key with specified scope",
        tags: ["Chat API Keys"],
        body: z
          .object({
            name: z.string().min(1, "Name is required"),
            provider: SupportedChatProviderSchema,
            apiKey: z.string().min(1).optional(),
            scope: ChatApiKeyScopeSchema.default("personal"),
            teamId: z.string().optional(),
            vaultSecretPath: z.string().min(1).optional(),
            vaultSecretKey: z.string().min(1).optional(),
          })
          .refine(
            (data) =>
              isByosEnabled()
                ? data.vaultSecretPath && data.vaultSecretKey
                : PROVIDERS_WITH_OPTIONAL_API_KEY.has(data.provider) ||
                  data.apiKey,
            {
              message:
                "Either apiKey or both vaultSecretPath and vaultSecretKey must be provided",
            },
          ),
        response: constructResponseSchema(SelectChatApiKeySchema),
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
        headers,
      });

      let secret: SelectSecret | null = null;
      let actualApiKeyValue: string | null = null;

      // If readonly_vault is enabled
      if (isByosEnabled()) {
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
        try {
          await testProviderApiKey(body.provider, actualApiKeyValue);
        } catch (_error) {
          throw new ApiError(
            400,
            `Invalid API key: Failed to connect to ${capitalize(body.provider)}`,
          );
        }
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
        try {
          await testProviderApiKey(body.provider, actualApiKeyValue);
        } catch (_error) {
          throw new ApiError(
            400,
            `Invalid API key: Failed to connect to ${capitalize(body.provider)}`,
          );
        }

        secret = await secretManager().createSecret(
          { apiKey: actualApiKeyValue },
          getChatApiKeySecretName({
            scope: body.scope,
            teamId: body.teamId ?? null,
            userId: user.id,
          }),
        );
      }

      if (!secret && !PROVIDERS_WITH_OPTIONAL_API_KEY.has(body.provider)) {
        throw new ApiError(
          400,
          "Secret creation failed, cannot create API key",
        );
      }

      // Create the API key record
      const createdApiKey = await ChatApiKeyModel.create({
        organizationId,
        name: body.name,
        provider: body.provider,
        secretId: secret?.id ?? null,
        scope: body.scope,
        userId: body.scope === "personal" ? user.id : null,
        teamId: body.scope === "team" ? body.teamId : null,
      });

      // Sync models for the new API key in background (non-blocking)
      if (actualApiKeyValue && modelSyncService.hasFetcher(body.provider)) {
        modelSyncService
          .syncModelsForApiKey(
            createdApiKey.id,
            body.provider,
            actualApiKeyValue,
          )
          .catch((error) => {
            logger.error(
              {
                apiKeyId: createdApiKey.id,
                provider: body.provider,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
              "Failed to sync models for new API key",
            );
          });
      }

      return reply.send(createdApiKey);
    },
  );

  // Get a single chat API key
  fastify.get(
    "/api/chat-api-keys/:id",
    {
      schema: {
        operationId: RouteId.GetChatApiKey,
        description: "Get a specific chat API key",
        tags: ["Chat API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(ChatApiKeyWithScopeInfoSchema),
      },
    },
    async ({ params, organizationId, user, headers }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Check visibility based on scope
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const { success: isProfileAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Personal keys: only visible to owner
      if (apiKey.scope === "personal" && apiKey.userId !== user.id) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Team keys: visible to team members or admins
      if (apiKey.scope === "team" && !isProfileAdmin) {
        if (!apiKey.teamId || !userTeamIds.includes(apiKey.teamId)) {
          throw new ApiError(404, "Chat API key not found");
        }
      }

      return reply.send(apiKey);
    },
  );

  // Update a chat API key
  fastify.patch(
    "/api/chat-api-keys/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatApiKey,
        description:
          "Update a chat API key (name, API key value, scope, or team)",
        tags: ["Chat API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z
          .object({
            name: z.string().min(1).optional(),
            apiKey: z.string().min(1).optional(),
            scope: ChatApiKeyScopeSchema.optional(),
            teamId: z.string().uuid().nullable().optional(),
            vaultSecretPath: z.string().min(1).optional(),
            vaultSecretKey: z.string().min(1).optional(),
          })
          .refine(
            (data) => {
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
                "Either apiKey or both vaultSecretPath and vaultSecretKey must be provided",
            },
          ),
        response: constructResponseSchema(SelectChatApiKeySchema),
      },
    },
    async ({ params, body, organizationId, user, headers }, reply) => {
      const apiKeyFromDB = await ChatApiKeyModel.findById(params.id);

      if (!apiKeyFromDB || apiKeyFromDB.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Check authorization based on current scope
      await authorizeApiKeyAccess(apiKeyFromDB, user.id, headers);

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
          headers,
        });
      }

      // Update the secret if a new API key is provided (via direct value or vault reference)
      if (body.apiKey || (body.vaultSecretPath && body.vaultSecretKey)) {
        let apiKeyValue: string;
        let vaultReference: string | undefined;

        if (isByosEnabled() && body.vaultSecretPath && body.vaultSecretKey) {
          // Get secret from vault
          const manager = assertByosEnabled();
          const vaultData = await manager.getSecretFromPath(
            body.vaultSecretPath,
          );
          apiKeyValue = vaultData[body.vaultSecretKey];
          if (!apiKeyValue) {
            throw new ApiError(
              400,
              `API key not found in Vault secret at path "${body.vaultSecretPath}" with key "${body.vaultSecretKey}"`,
            );
          }
          vaultReference = `${body.vaultSecretPath}#${body.vaultSecretKey}`;
        } else if (body.apiKey) {
          // Use direct API key value
          apiKeyValue = body.apiKey;
        } else {
          // This shouldn't happen due to refine, but TypeScript needs this
          throw new ApiError(400, "API key or vault reference is required");
        }

        // Test the API key before saving
        try {
          await testProviderApiKey(apiKeyFromDB.provider, apiKeyValue);
        } catch (_error) {
          throw new ApiError(
            400,
            `Invalid API key: Failed to connect to ${capitalize(apiKeyFromDB.provider)}`,
          );
        }

        // Update or create the secret
        if (apiKeyFromDB.secretId) {
          // Update with vault reference
          await secretManager().updateSecret(apiKeyFromDB.secretId, {
            apiKey: vaultReference ?? apiKeyValue,
          });
        } else {
          // Create new secret
          const secret = await secretManager().createSecret(
            { apiKey: vaultReference ?? apiKeyValue },
            getChatApiKeySecretName({
              scope: newScope,
              teamId: newTeamId,
              userId: user.id,
            }),
          );
          newSecretId = secret.id;
        }
      }

      // Build update object
      const updateData: Partial<{
        name: string;
        scope: "personal" | "team" | "org_wide";
        userId: string | null;
        teamId: string | null;
        secretId: string | null;
      }> = {};

      if (body.name) {
        updateData.name = body.name;
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
        await ChatApiKeyModel.update(params.id, updateData);
      }

      const updated = await ChatApiKeyModel.findById(params.id);
      if (!updated) {
        throw new ApiError(404, "Chat API key not found");
      }
      return reply.send(updated);
    },
  );

  // Delete a chat API key
  fastify.delete(
    "/api/chat-api-keys/:id",
    {
      schema: {
        operationId: RouteId.DeleteChatApiKey,
        description: "Delete a chat API key",
        tags: ["Chat API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId, user, headers }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Check authorization based on scope
      await authorizeApiKeyAccess(apiKey, user.id, headers);

      // Delete the associated secret
      if (apiKey.secretId) {
        await secretManager().deleteSecret(apiKey.secretId);
      }

      await ChatApiKeyModel.delete(params.id);

      return reply.send({ success: true });
    },
  );
};

/**
 * Validates scope/teamId combination and checks user authorization for the scope.
 * Used for both creating and updating API keys.
 */
async function validateScopeAndAuthorization(params: {
  scope: "personal" | "team" | "org_wide";
  teamId: string | null | undefined;
  userId: string;
  headers: IncomingHttpHeaders;
}): Promise<void> {
  const { scope, teamId, userId, headers } = params;

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

  if (scope === "org_wide" && teamId) {
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

  // For org-wide keys, require profile admin permission
  if (scope === "org_wide") {
    const { success: isProfileAdmin } = await hasPermission(
      { profile: ["admin"] },
      headers,
    );
    if (!isProfileAdmin) {
      throw new ApiError(403, "Only admins can use organization-wide scope");
    }
  }
}

/**
 * Helper to check if a user is authorized to modify an API key based on scope
 */
async function authorizeApiKeyAccess(
  apiKey: { scope: string; userId: string | null; teamId: string | null },
  userId: string,
  headers: IncomingHttpHeaders,
): Promise<void> {
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

  // Org-wide keys: require profile admin
  if (apiKey.scope === "org_wide") {
    const { success: isProfileAdmin } = await hasPermission(
      { profile: ["admin"] },
      headers,
    );
    if (!isProfileAdmin) {
      throw new ApiError(
        403,
        "Only admins can modify organization-wide API keys",
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
  scope: "personal" | "team" | "org_wide";
  teamId: string | null;
  userId: string | null;
}): string {
  if (scope === "personal") {
    return `chatapikey-personal-${userId}`;
  }
  if (scope === "team") {
    return `chatapikey-team-${teamId}`;
  }
  return `chatapikey-org_wide`;
}

/**
 * Validates that the provider is allowed based on current configuration.
 * Throws ApiError if Gemini provider is requested while Vertex AI is enabled.
 */
export function validateProviderAllowed(provider: SupportedChatProvider): void {
  if (provider === "gemini" && isVertexAiEnabled()) {
    throw new ApiError(
      400,
      "Cannot create Gemini API key: Vertex AI is configured. Gemini uses Application Default Credentials instead of API keys.",
    );
  }
}

export default chatApiKeysRoutes;
