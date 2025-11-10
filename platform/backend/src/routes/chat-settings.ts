import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatSettingsModel, SecretModel } from "@/models";
import { constructResponseSchema } from "@/types";

const ChatSettingsSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  anthropicApiKeySecretId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const UpdateChatSettingsSchema = z.object({
  anthropicApiKey: z.string().optional(),
  resetApiKey: z.boolean().optional(),
});

const chatSettingsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/chat-settings",
    {
      schema: {
        operationId: RouteId.GetChatSettings,
        description: "Get chat settings for the organization",
        tags: ["Chat Settings"],
        response: constructResponseSchema(ChatSettingsSchema),
      },
    },
    async ({ organizationId }, reply) => {
      try {
        const settings = await ChatSettingsModel.getOrCreate(organizationId);
        return reply.send(settings);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        body: UpdateChatSettingsSchema,
        response: constructResponseSchema(ChatSettingsSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      try {
        // Get or create settings
        const settings = await ChatSettingsModel.getOrCreate(organizationId);

        let secretId = settings.anthropicApiKeySecretId;

        // Handle reset API key request
        if (body.resetApiKey === true) {
          secretId = null;
        }
        // If API key is provided, create or update secret
        else if (body.anthropicApiKey && body.anthropicApiKey.trim() !== "") {
          if (secretId) {
            // Update existing secret
            await SecretModel.update(secretId, {
              secret: { anthropicApiKey: body.anthropicApiKey },
            });
          } else {
            // Create new secret
            const secret = await SecretModel.create({
              secret: { anthropicApiKey: body.anthropicApiKey },
            });
            secretId = secret.id;
          }
        }

        // Update settings (only if secretId changed or was created)
        const updated = await ChatSettingsModel.update(organizationId, {
          anthropicApiKeySecretId: secretId,
        });

        if (!updated) {
          return reply.status(404).send({
            error: {
              message: "Chat settings not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updated);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default chatSettingsRoutes;
