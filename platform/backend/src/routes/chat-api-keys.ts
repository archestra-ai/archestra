import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatApiKeyModel } from "@/models";
import { isByosEnabled, secretManager } from "@/secretsmanager";
import {
  ApiError,
  ChatApiKeyWithProfilesSchema,
  constructResponseSchema,
  SelectChatApiKeySchema,
  SupportedChatProviderSchema,
} from "@/types";

const chatApiKeysRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // List all chat API keys for the organization
  fastify.get(
    "/api/chat-api-keys",
    {
      schema: {
        operationId: RouteId.GetChatApiKeys,
        description: "Get all chat API keys for the organization",
        tags: ["Chat API Keys"],
        response: constructResponseSchema(
          z.array(ChatApiKeyWithProfilesSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      const apiKeys =
        await ChatApiKeyModel.findByOrganizationIdWithProfiles(organizationId);
      return reply.send(apiKeys);
    },
  );

  // Create a new chat API key
  fastify.post(
    "/api/chat-api-keys",
    {
      schema: {
        operationId: RouteId.CreateChatApiKey,
        description: "Create a new chat API key",
        tags: ["Chat API Keys"],
        body: z.object({
          name: z.string().min(1, "Name is required"),
          provider: SupportedChatProviderSchema,
          apiKey: z.string().min(1, "API key is required"),
          isOrganizationDefault: z.boolean().optional().default(false),
        }),
        response: constructResponseSchema(SelectChatApiKeySchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      // Use forceDB when BYOS is enabled because chat API keys are user-provided values
      const forceDB = isByosEnabled();

      // Create the secret for the API key
      const secret = await secretManager().createSecret(
        { apiKey: body.apiKey },
        "chatapikey",
        forceDB,
      );

      // If setting as default, first unset any existing default
      if (body.isOrganizationDefault) {
        const existingDefault = await ChatApiKeyModel.findOrganizationDefault(
          organizationId,
          body.provider,
        );
        if (existingDefault) {
          await ChatApiKeyModel.unsetOrganizationDefault(existingDefault.id);
        }
      }

      // Create the API key record
      const apiKey = await ChatApiKeyModel.create({
        organizationId,
        name: body.name,
        provider: body.provider,
        secretId: secret.id,
        isOrganizationDefault: body.isOrganizationDefault,
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
        response: constructResponseSchema(ChatApiKeyWithProfilesSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      const profiles = await ChatApiKeyModel.getAssignedProfiles(apiKey.id);

      return reply.send({
        ...apiKey,
        profiles,
      });
    },
  );

  // Update a chat API key
  fastify.patch(
    "/api/chat-api-keys/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatApiKey,
        description: "Update a chat API key",
        tags: ["Chat API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z.object({
          name: z.string().min(1).optional(),
          apiKey: z.string().min(1).optional(),
        }),
        response: constructResponseSchema(SelectChatApiKeySchema),
      },
    },
    async ({ params, body, organizationId }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
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

      // Update the name if provided
      if (body.name) {
        await ChatApiKeyModel.update(params.id, { name: body.name });
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
    async ({ params, organizationId }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Delete the associated secret
      if (apiKey.secretId) {
        await secretManager().deleteSecret(apiKey.secretId);
      }

      await ChatApiKeyModel.delete(params.id);

      return reply.send({ success: true });
    },
  );

  // Set a chat API key as organization default
  fastify.post(
    "/api/chat-api-keys/:id/set-default",
    {
      schema: {
        operationId: RouteId.SetChatApiKeyDefault,
        description: "Set a chat API key as the organization default",
        tags: ["Chat API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(SelectChatApiKeySchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      const updated = await ChatApiKeyModel.setAsOrganizationDefault(params.id);

      if (!updated) {
        throw new ApiError(500, "Failed to set API key as default");
      }

      return reply.send(updated);
    },
  );

  // Unset a chat API key as organization default
  fastify.post(
    "/api/chat-api-keys/:id/unset-default",
    {
      schema: {
        operationId: RouteId.UnsetChatApiKeyDefault,
        description: "Unset a chat API key as the organization default",
        tags: ["Chat API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(SelectChatApiKeySchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      const updated = await ChatApiKeyModel.unsetOrganizationDefault(params.id);

      if (!updated) {
        throw new ApiError(500, "Failed to unset API key as default");
      }

      return reply.send(updated);
    },
  );

  // Update profile assignments for a chat API key
  fastify.put(
    "/api/chat-api-keys/:id/profiles",
    {
      schema: {
        operationId: RouteId.UpdateChatApiKeyProfiles,
        description: "Update profile assignments for a chat API key",
        tags: ["Chat API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z.object({
          profileIds: z.array(z.string().uuid()),
        }),
        response: constructResponseSchema(ChatApiKeyWithProfilesSchema),
      },
    },
    async ({ params, body, organizationId }, reply) => {
      const apiKey = await ChatApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      await ChatApiKeyModel.replaceProfileAssignments(
        params.id,
        body.profileIds,
      );

      const profiles = await ChatApiKeyModel.getAssignedProfiles(params.id);

      return reply.send({
        ...apiKey,
        profiles,
      });
    },
  );

  // Bulk assign multiple API keys to profiles
  fastify.post(
    "/api/chat-api-keys/bulk-assign",
    {
      schema: {
        operationId: RouteId.BulkAssignChatApiKeysToProfiles,
        description:
          "Assign multiple API keys to multiple profiles. Only one key per provider is allowed per profile - existing assignments for the same provider will be replaced.",
        tags: ["Chat API Keys"],
        body: z.object({
          chatApiKeyIds: z
            .array(z.string().uuid())
            .min(1, "At least one API key is required"),
          profileIds: z
            .array(z.string().uuid())
            .min(1, "At least one profile is required"),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            assignedCount: z.number(),
          }),
        ),
      },
    },
    async ({ body, organizationId }, reply) => {
      // Verify all API keys exist and belong to the organization
      const apiKeys = await Promise.all(
        body.chatApiKeyIds.map((id) => ChatApiKeyModel.findById(id)),
      );

      for (const apiKey of apiKeys) {
        if (!apiKey || apiKey.organizationId !== organizationId) {
          throw new ApiError(404, "One or more chat API keys not found");
        }
      }

      // Assign each API key to each profile
      // The model method handles the one-key-per-provider-per-profile constraint
      for (const chatApiKeyId of body.chatApiKeyIds) {
        await ChatApiKeyModel.bulkAssignProfiles(chatApiKeyId, body.profileIds);
      }

      // Calculate actual assignment count based on unique providers
      // Since only one key per provider is allowed per profile, same-provider keys replace each other
      const validApiKeys = apiKeys.filter(
        (key): key is NonNullable<typeof key> => key !== null,
      );
      const uniqueProviders = new Set(validApiKeys.map((key) => key.provider));
      const assignedCount = uniqueProviders.size * body.profileIds.length;

      return reply.send({
        success: true,
        assignedCount,
      });
    },
  );
};

export default chatApiKeysRoutes;
