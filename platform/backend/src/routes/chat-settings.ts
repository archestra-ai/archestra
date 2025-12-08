import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { ChatSettingsModel, SecretModel } from "@/models";
import { isByosEnabled, secretManager } from "@/secretsmanager";
import {
  ApiError,
  ChatSettingsResponseSchema,
  constructResponseSchema,
} from "@/types";

const chatSettingsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/chat-settings",
    {
      schema: {
        operationId: RouteId.GetChatSettings,
        description: "Get chat settings for the organization",
        tags: ["Chat Settings"],
        response: constructResponseSchema(ChatSettingsResponseSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const settings = await ChatSettingsModel.getOrCreate(organizationId);

      // If there's an API key secret, check if it's from BYOS Vault
      // It's needed to show a path to Vault secret in the UI.
      let externalVaultSecretPath: string | null = null;
      if (settings.anthropicApiKeySecretId) {
        const secret = await SecretModel.findById(
          settings.anthropicApiKeySecretId,
        );
        if (secret?.vaultPath) {
          externalVaultSecretPath = secret.vaultPath;
        }
      }

      return reply.send({
        ...settings,
        externalVaultSecretPath,
      });
    },
  );

  fastify.patch(
    "/api/chat-settings",
    {
      schema: {
        operationId: RouteId.UpdateChatSettings,
        description:
          "Update chat settings (Anthropic API key) for the organization",
        tags: ["Chat Settings"],
        body: z.object({
          anthropicApiKey: z.string().optional(),
          resetApiKey: z.boolean().optional(),
          // For BYOS (Bring Your Own Secrets) - external Vault path
          externalVaultSecret: z.string().optional(),
        }),
        response: constructResponseSchema(ChatSettingsResponseSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      // Get or create settings
      const settings = await ChatSettingsModel.getOrCreate(organizationId);

      let secretId = settings.anthropicApiKeySecretId;

      // Handle reset API key request
      if (body.resetApiKey === true) {
        // Delete the secret from storage (Vault/DB)
        if (secretId) {
          await secretManager.deleteSecret(secretId);
        }
        secretId = null;
      } else if (body.externalVaultSecret) {
        // BYOS flow - create a secret reference to external Vault path
        if (!isByosEnabled()) {
          throw new ApiError(
            400,
            "BYOS (Bring Your Own Secrets) is not enabled. " +
              "Requires ARCHESTRA_SECRETS_MANAGER=BYOS_VAULT and an enterprise license.",
          );
        }

        // Delete existing secret if any
        if (secretId) {
          await secretManager.deleteSecret(secretId);
        }

        // Create new secret reference
        const secret = await secretManager.createSecret(
          { __vaultPath: body.externalVaultSecret },
          "chat-anthropic-api-key-vault-secret",
        );
        secretId = secret.id;
        logger.info(
          { secretId: secret.id, vaultPath: body.externalVaultSecret },
          "Created BYOS external vault secret reference for chat API key",
        );
      } else if (body.anthropicApiKey && body.anthropicApiKey.trim() !== "") {
        // If API key is provided directly, create or update secret
        if (secretId) {
          // Update existing secret
          await secretManager.updateSecret(secretId, {
            anthropicApiKey: body.anthropicApiKey,
          });
        } else {
          // Create new secret
          const secret = await secretManager.createSecret(
            { anthropicApiKey: body.anthropicApiKey },
            "chatapikey",
          );
          secretId = secret.id;
        }
      }

      // Update settings (only if secretId changed or was created)
      const updated = await ChatSettingsModel.update(organizationId, {
        anthropicApiKeySecretId: secretId,
      });

      if (!updated) {
        throw new ApiError(404, "Chat settings not found");
      }

      // Get the vault path if this is a BYOS secret
      let externalVaultSecretPath: string | null = null;
      if (secretId) {
        const secret = await SecretModel.findById(secretId);
        if (secret?.vaultPath) {
          externalVaultSecretPath = secret.vaultPath;
        }
      }

      return reply.send({
        ...updated,
        externalVaultSecretPath,
      });
    },
  );
};

export default chatSettingsRoutes;
