import { DEFAULT_VAULT_TOKEN, RouteId, SecretsManagerType } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import SecretModel from "@/models/secret";
import {
  isByosEnabled,
  secretManager,
  secretManagerCoordinator,
} from "@/secretsmanager";
import {
  ApiError,
  constructResponseSchema,
  SelectSecretSchema,
  UuidIdSchema,
} from "@/types";

const SecretsManagerTypeSchema = z.nativeEnum(SecretsManagerType);

const secretsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/secrets/type",
    {
      schema: {
        operationId: RouteId.GetSecretsType,
        description:
          "Get the secrets manager type and configuration details (for Vault)",
        tags: ["Secrets"],
        response: constructResponseSchema(
          z.object({
            type: SecretsManagerTypeSchema,
            meta: z.record(z.string(), z.string()),
          }),
        ),
      },
    },
    async (_request, reply) => {
      return reply.send(secretManager().getUserVisibleDebugInfo());
    },
  );

  fastify.get(
    "/api/secrets/:id",
    {
      schema: {
        operationId: RouteId.GetSecret,
        description: "Get a secret by ID",
        tags: ["Secrets"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectSecretSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      // Security: Only allow access to secrets when BYOS is enabled or the secret is a BYOS secret.
      // This prevents exposing actual secret values (API keys, tokens, etc.) when BYOS is not enabled.
      // When BYOS is enabled, secrets contain vault references (safe to expose) rather than actual values.
      const secret = await SecretModel.findById(id);

      if (!secret) {
        throw new ApiError(404, "Secret not found");
      }

      // Only allow access if BYOS is enabled globally OR the secret is a BYOS secret
      if (!isByosEnabled() && !secret.isByosVault) {
        throw new ApiError(
          403,
          "Access to secrets is only allowed for BYOS (Bring Your Own Secrets) secrets when BYOS is enabled",
        );
      }

      // For BYOS secrets, we want to return the raw secret column (vault references)
      // without resolving them. Use SecretModel directly instead of secretManager
      // to avoid resolving vault references.
      return reply.send(secret);
    },
  );

  fastify.post(
    "/api/secrets/check-connectivity",
    {
      schema: {
        operationId: RouteId.CheckSecretsConnectivity,
        description:
          "Check connectivity to the secrets storage and return secret count.",
        tags: ["Secrets"],
        response: constructResponseSchema(
          z.object({
            secretCount: z.number(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      const result = await secretManager().checkConnectivity();
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/secrets/initialize-secrets-manager",
    {
      schema: {
        operationId: RouteId.InitializeSecretsManager,
        description:
          "Initialize the secrets manager with a specific type (DB, Vault, or BYOS_VAULT)",
        tags: ["Secrets"],
        body: z.object({
          type: SecretsManagerTypeSchema,
        }),
        response: constructResponseSchema(
          z.object({
            type: SecretsManagerTypeSchema,
            meta: z.record(z.string(), z.string()),
          }),
        ),
      },
    },
    async (request, reply) => {
      if (config.vault.token !== DEFAULT_VAULT_TOKEN) {
        throw new ApiError(
          400,
          "Reinitializing secrets manager is not allowed in production environment",
        );
      }
      const { type } = request.body;
      const instance = await secretManagerCoordinator.initialize(type);
      return reply.send(instance.getUserVisibleDebugInfo());
    },
  );
};

export default secretsRoutes;
