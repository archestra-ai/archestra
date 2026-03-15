import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { auth as betterAuth } from "@/auth/better-auth";
import ApiKeyModel from "@/models/api-key";
import {
  ApiError,
  ApiKeyIdParamsSchema,
  ApiKeyResponseSchema,
  ApiKeyWithValueResponseSchema,
  constructResponseSchema,
  CreateApiKeyBodySchema,
  DeleteApiKeyResponseSchema,
  UpdateApiKeyBodySchema,
} from "@/types";

const apiKeyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/api-keys",
    {
      schema: {
        operationId: RouteId.GetApiKeys,
        description: "List the authenticated user's Archestra API keys",
        tags: ["API Keys"],
        response: constructResponseSchema(ApiKeyResponseSchema.array()),
      },
    },
    async ({ user }, reply) => {
      const apiKeys = await ApiKeyModel.listByUserId(user.id);
      return reply.send(apiKeys);
    },
  );

  fastify.get(
    "/api/api-keys/:id",
    {
      schema: {
        operationId: RouteId.GetApiKey,
        description: "Get one authenticated user's Archestra API key",
        tags: ["API Keys"],
        params: ApiKeyIdParamsSchema,
        response: constructResponseSchema(ApiKeyResponseSchema),
      },
    },
    async ({ user, params }, reply) => {
      const apiKey = await ApiKeyModel.findByIdForUser(params.id, user.id);
      if (!apiKey) {
        throw new ApiError(404, "API key not found");
      }

      return reply.send(apiKey);
    },
  );

  fastify.post(
    "/api/api-keys",
    {
      schema: {
        operationId: RouteId.CreateApiKey,
        description: "Create an Archestra API key for the authenticated user",
        tags: ["API Keys"],
        body: CreateApiKeyBodySchema,
        response: constructResponseSchema(ApiKeyWithValueResponseSchema),
      },
    },
    async (request, reply) => {
      try {
        const apiKey = await betterAuth.api.createApiKey({
          headers: new Headers(request.headers as HeadersInit),
          body: request.body,
        });

        return reply.send(apiKey);
      } catch (error) {
        throw toApiError(error, 400);
      }
    },
  );

  fastify.patch(
    "/api/api-keys/:id",
    {
      schema: {
        operationId: RouteId.UpdateApiKey,
        description: "Update an Archestra API key for the authenticated user",
        tags: ["API Keys"],
        params: ApiKeyIdParamsSchema,
        body: UpdateApiKeyBodySchema,
        response: constructResponseSchema(ApiKeyResponseSchema),
      },
    },
    async (request, reply) => {
      const existingApiKey = await ApiKeyModel.findByIdForUser(
        request.params.id,
        request.user.id,
      );
      if (!existingApiKey) {
        throw new ApiError(404, "API key not found");
      }

      try {
        const apiKey = await betterAuth.api.updateApiKey({
          headers: new Headers(request.headers as HeadersInit),
          body: {
            keyId: request.params.id,
            ...request.body,
          },
        });

        return reply.send(apiKey);
      } catch (error) {
        throw toApiError(error, 400);
      }
    },
  );

  fastify.delete(
    "/api/api-keys/:id",
    {
      schema: {
        operationId: RouteId.DeleteApiKey,
        description: "Delete an Archestra API key for the authenticated user",
        tags: ["API Keys"],
        params: ApiKeyIdParamsSchema,
        response: constructResponseSchema(DeleteApiKeyResponseSchema),
      },
    },
    async (request, reply) => {
      const existingApiKey = await ApiKeyModel.findByIdForUser(
        request.params.id,
        request.user.id,
      );
      if (!existingApiKey) {
        throw new ApiError(404, "API key not found");
      }

      try {
        const result = await betterAuth.api.deleteApiKey({
          headers: new Headers(request.headers as HeadersInit),
          body: { keyId: request.params.id },
        });

        return reply.send(result);
      } catch (error) {
        throw toApiError(error, 500);
      }
    },
  );
};

export default apiKeyRoutes;

// === Internal helpers

function toApiError(error: unknown, fallbackStatusCode: number): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    const statusCode = getStatusCode(error, fallbackStatusCode);
    return new ApiError(statusCode, error.message);
  }

  return new ApiError(fallbackStatusCode, "API key request failed");
}

function getStatusCode(error: Error, fallbackStatusCode: number): number {
  const maybeStatusCode = (error as Error & { statusCode?: unknown }).statusCode;
  if (typeof maybeStatusCode === "number") {
    return maybeStatusCode;
  }

  if (error.message.toLowerCase().includes("not found")) {
    return 404;
  }

  return fallbackStatusCode;
}
