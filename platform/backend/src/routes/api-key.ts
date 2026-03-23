import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { auth as betterAuth } from "@/auth/better-auth";
import ApiKeyModel from "@/models/api-key";
import {
  ApiError,
  ApiKeyIdParamsSchema,
  ApiKeyResponseSchema,
  ApiKeyWithValueResponseSchema,
  CreateApiKeyBodySchema,
  constructResponseSchema,
  DeleteApiKeyResponseSchema,
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
          body: normalizeCreateApiKeyBody(request.body),
        });

        return reply.send(normalizeCreatedApiKeyResponse(apiKey));
      } catch (error) {
        throw toApiError(error, {
          fallbackStatusCode: 400,
          fallbackMessage: "Failed to create API key",
        });
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
        throw toApiError(error, {
          fallbackStatusCode: 500,
          fallbackMessage: "Failed to delete API key",
        });
      }
    },
  );
};

export default apiKeyRoutes;

// === Internal helpers

function toApiError(
  error: unknown,
  params: { fallbackStatusCode: number; fallbackMessage: string },
): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  const statusCode = getStatusCode(error, params.fallbackStatusCode);
  const message = getApiKeyErrorMessage(statusCode, params.fallbackMessage);

  if (error instanceof Error) {
    return new ApiError(statusCode, message);
  }

  return new ApiError(statusCode, message);
}

function getStatusCode(error: unknown, fallbackStatusCode: number): number {
  const maybeStatusCode = (
    error as Error & { statusCode?: unknown; status?: unknown }
  ).statusCode;
  if (typeof maybeStatusCode === "number") {
    return maybeStatusCode;
  }

  const maybeStatus = (error as Error & { status?: unknown }).status;
  if (typeof maybeStatus === "number") {
    return maybeStatus;
  }

  return fallbackStatusCode;
}

function getApiKeyErrorMessage(
  statusCode: number,
  fallbackMessage: string,
): string {
  switch (statusCode) {
    case 400:
      return fallbackMessage;
    case 401:
      return "Authentication required";
    case 403:
      return "Forbidden";
    case 404:
      return "API key not found";
    default:
      return fallbackMessage;
  }
}

function normalizeCreatedApiKeyResponse(apiKey: {
  id: string;
  configId: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  referenceId: string;
  enabled: boolean;
  lastRequest: string | Date | null;
  expiresAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  refillInterval: number | null;
  refillAmount: number | null;
  lastRefillAt: string | Date | null;
  rateLimitEnabled: boolean;
  rateLimitTimeWindow: number | null;
  rateLimitMax: number | null;
  requestCount: number;
  remaining: number | null;
  metadata?: Record<string, unknown> | null;
  permissions?: Record<string, string[]> | null;
  key: string;
}) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    start: apiKey.start,
    prefix: apiKey.prefix,
    userId: apiKey.referenceId,
    enabled: apiKey.enabled,
    lastRequest: toDateOrNull(apiKey.lastRequest),
    expiresAt: toDateOrNull(apiKey.expiresAt),
    createdAt: toDate(apiKey.createdAt),
    updatedAt: toDate(apiKey.updatedAt),
    metadata: apiKey.metadata ?? null,
    permissions: apiKey.permissions ?? null,
    key: apiKey.key,
  };
}

function normalizeCreateApiKeyBody(body: {
  expiresIn?: number | null;
  name?: string | null;
}) {
  const { name, ...rest } = body;

  return {
    ...rest,
    ...(name === null ? {} : { name }),
  };
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: string | Date | null): Date | null {
  if (!value) return null;
  return toDate(value);
}
