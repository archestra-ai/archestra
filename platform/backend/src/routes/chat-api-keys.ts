import type { IncomingHttpHeaders } from "node:http";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { capitalize } from "lodash-es";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { ChatApiKeyModel, TeamModel } from "@/models";
import { testProviderApiKey } from "@/routes/chat-models";
import { isByosEnabled, secretManager } from "@/secretsmanager";
import {
  ApiError,
  ChatApiKeyScopeSchema,
  ChatApiKeyWithScopeInfoSchema,
  constructResponseSchema,
  SelectChatApiKeySchema,
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
      return reply.send(apiKeys);
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
        body: z.object({
          name: z.string().min(1, "Name is required"),
          provider: SupportedChatProviderSchema,
          apiKey: z.string().min(1, "API key is required"),
          scope: ChatApiKeyScopeSchema.default("personal"),
          teamId: z.string().optional(),
        }),
        response: constructResponseSchema(SelectChatApiKeySchema),
      },
    },
    async ({ body, organizationId, user, headers }, reply) => {
      // Validate scope/teamId combination and authorization
      await validateScopeAndAuthorization({
        scope: body.scope,
        teamId: body.teamId,
        userId: user.id,
        headers,
      });

      // Test the API key before saving
      try {
        await testProviderApiKey(body.provider, body.apiKey);
      } catch (_error) {
        throw new ApiError(
          400,
          `Invalid API key: Failed to connect to ${capitalize(body.provider)}`,
        );
      }

      // Use forceDB when BYOS is enabled because chat API keys are user-provided values
      const forceDB = isByosEnabled();

      // Create the secret for the API key
      const secret = await secretManager().createSecret(
        { apiKey: body.apiKey },
        "chatapikey",
        forceDB,
      );

      // Create the API key record
      const apiKey = await ChatApiKeyModel.create({
        organizationId,
        name: body.name,
        provider: body.provider,
        secretId: secret.id,
        scope: body.scope,
        userId: body.scope === "personal" ? user.id : null,
        teamId: body.scope === "team" ? body.teamId : null,
      });

      return reply.send(apiKey);
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
        body: z.object({
          name: z.string().min(1).optional(),
          apiKey: z.string().min(1).optional(),
          scope: ChatApiKeyScopeSchema.optional(),
          teamId: z.string().uuid().nullable().optional(),
        }),
        response: constructResponseSchema(SelectChatApiKeySchema),
      },
    },
    async ({ params, body, organizationId, user, headers }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Check authorization based on current scope
      await authorizeApiKeyAccess(apiKey, user.id, headers);

      // If scope is changing, validate the new scope
      const newScope = body.scope ?? apiKey.scope;
      const newTeamId = body.teamId !== undefined ? body.teamId : apiKey.teamId;

      if (body.scope !== undefined || body.teamId !== undefined) {
        await validateScopeAndAuthorization({
          scope: newScope,
          teamId: newTeamId,
          userId: user.id,
          headers,
        });
      }

      // Test the API key before saving (only if a new key is provided)
      if (body.apiKey) {
        try {
          await testProviderApiKey(apiKey.provider, body.apiKey);
        } catch (_error) {
          throw new ApiError(
            400,
            `Invalid API key: Failed to connect to ${capitalize(apiKey.provider)}`,
          );
        }
      }

      // Update the secret if a new API key is provided
      if (body.apiKey) {
        if (apiKey.secretId) {
          await secretManager().updateSecret(apiKey.secretId, {
            apiKey: body.apiKey,
          });
        } else {
          const forceDB = isByosEnabled();
          const secret = await secretManager().createSecret(
            { apiKey: body.apiKey },
            "chatapikey",
            forceDB,
          );
          await ChatApiKeyModel.update(params.id, { secretId: secret.id });
        }
      }

      // Build update object
      const updateData: Partial<{
        name: string;
        scope: "personal" | "team" | "org_wide";
        userId: string | null;
        teamId: string | null;
      }> = {};

      if (body.name) {
        updateData.name = body.name;
      }

      if (body.scope !== undefined) {
        updateData.scope = body.scope;
        // Set userId/teamId based on new scope
        updateData.userId = body.scope === "personal" ? user.id : null;
        updateData.teamId = body.scope === "team" ? newTeamId : null;
      } else if (body.teamId !== undefined && apiKey.scope === "team") {
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

export default chatApiKeysRoutes;
