import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatSettingsModel } from "@/models";
import {
  DbSecretsManager,
  isByosEnabled,
  secretManager,
} from "@/secretsmanager";
import {
  ApiError,
  constructResponseSchema,
  SelectChatSettingsSchema,
} from "@/types";

const chatSettingsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/chat-settings",
    {
      schema: {
        operationId: RouteId.GetChatSettings,
        description: "Get chat settings for the organization",
        tags: ["Chat Settings"],
        response: constructResponseSchema(SelectChatSettingsSchema),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await ChatSettingsModel.getOrCreate(organizationId));
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
        }),
        response: constructResponseSchema(SelectChatSettingsSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      // Get or create settings
      const settings = await ChatSettingsModel.getOrCreate(organizationId);

      let secretId = settings.anthropicApiKeySecretId;

      // Use DB secrets manager for chat API keys when BYOS is enabled
      // because BYOS doesn't support chat API keys yet (it's designed for external Vault references)
      const secrets = isByosEnabled() ? new DbSecretsManager() : secretManager;

      // Handle reset API key request
      if (body.resetApiKey === true) {
        // Delete the secret from storage (Vault/DB)
        if (secretId) {
          await secrets.deleteSecret(secretId);
        }
        secretId = null;
      } else if (body.anthropicApiKey && body.anthropicApiKey.trim() !== "") {
        // If API key is provided, create or update secret
        if (secretId) {
          // Update existing secret
          await secrets.updateSecret(secretId, {
            anthropicApiKey: body.anthropicApiKey,
          });
        } else {
          // Create new secret
          const secret = await secrets.createSecret(
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

      return reply.send(updated);
    },
  );
};

export default chatSettingsRoutes;
