import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatSettingsModel, SecretModel } from "@/models";
import { constructResponseSchema, SelectChatSettingsSchema } from "@/types";

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
      try {
        return reply.send(await ChatSettingsModel.getOrCreate(organizationId));
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
        body: z.object({
          anthropicApiKey: z.string().optional(),
          resetApiKey: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectChatSettingsSchema),
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
        } else if (body.anthropicApiKey && body.anthropicApiKey.trim() !== "") {
          // If API key is provided, create or update secret
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
