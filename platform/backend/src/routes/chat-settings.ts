import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatSettingsModel } from "@/models";
import { secretManager } from "@/secretsmanager";
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
          autoConfigureNewTools: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectChatSettingsSchema),
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
      } else if (body.anthropicApiKey && body.anthropicApiKey.trim() !== "") {
        // If API key is provided, create or update secret
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

      // Update settings
      const updateData: Parameters<typeof ChatSettingsModel.update>[1] = {
        anthropicApiKeySecretId: secretId,
      };

      if (body.autoConfigureNewTools !== undefined) {
        updateData.autoConfigureNewTools = body.autoConfigureNewTools;
      }

      const updated = await ChatSettingsModel.update(
        organizationId,
        updateData,
      );

      if (!updated) {
        throw new ApiError(404, "Chat settings not found");
      }

      return reply.send(updated);
    },
  );
};

export default chatSettingsRoutes;
