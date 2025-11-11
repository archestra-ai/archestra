import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatSettingsModel, SecretModel } from "@/models";
import { constructResponseSchema } from "@/types";

const ChatSettingsSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().nullable(),
  anthropicApiKeySecretId: z.string().nullable(),
  openaiApiKeySecretId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const UpdateChatSettingsSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).optional(),
  model: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  resetAnthropicApiKey: z.boolean().optional(),
  resetOpenaiApiKey: z.boolean().optional(),
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
          "Update chat settings (provider and API keys) for the organization",
        tags: ["Chat Settings"],
        body: UpdateChatSettingsSchema,
        response: constructResponseSchema(ChatSettingsSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      try {
        // Get or create settings
        const settings = await ChatSettingsModel.getOrCreate(organizationId);

        let anthropicSecretId = settings.anthropicApiKeySecretId;
        let openaiSecretId = settings.openaiApiKeySecretId;
        let provider = settings.provider;
        let model = settings.model;

        // Handle provider change
        if (body.provider) {
          provider = body.provider;
        }

        // Handle model change
        if (body.model !== undefined) {
          model = body.model;
        }

        // Handle Anthropic API key reset
        if (body.resetAnthropicApiKey === true) {
          anthropicSecretId = null;
        }
        // Handle Anthropic API key update/create
        else if (body.anthropicApiKey && body.anthropicApiKey.trim() !== "") {
          if (anthropicSecretId) {
            // Update existing secret
            await SecretModel.update(anthropicSecretId, {
              secret: { anthropicApiKey: body.anthropicApiKey },
            });
          } else {
            // Create new secret
            const secret = await SecretModel.create({
              secret: { anthropicApiKey: body.anthropicApiKey },
            });
            anthropicSecretId = secret.id;
          }
        }

        // Handle OpenAI API key reset
        if (body.resetOpenaiApiKey === true) {
          openaiSecretId = null;
        }
        // Handle OpenAI API key update/create
        else if (body.openaiApiKey && body.openaiApiKey.trim() !== "") {
          if (openaiSecretId) {
            // Update existing secret
            await SecretModel.update(openaiSecretId, {
              secret: { openaiApiKey: body.openaiApiKey },
            });
          } else {
            // Create new secret
            const secret = await SecretModel.create({
              secret: { openaiApiKey: body.openaiApiKey },
            });
            openaiSecretId = secret.id;
          }
        }

        // Update settings
        const updated = await ChatSettingsModel.update(organizationId, {
          provider,
          model,
          anthropicApiKeySecretId: anthropicSecretId,
          openaiApiKeySecretId: openaiSecretId,
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
