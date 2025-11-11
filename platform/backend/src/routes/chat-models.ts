import AnthropicProvider from "@anthropic-ai/sdk";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAI from "openai";
import { z } from "zod";
import config from "@/config";
import { ChatSettingsModel, SecretModel } from "@/models";
import { constructResponseSchema } from "@/types";

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
});

const ModelsResponseSchema = z.object({
  models: z.array(ModelSchema),
});

const chatModelsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get available models from the configured provider
   */
  fastify.get(
    "/api/chat-models",
    {
      schema: {
        operationId: RouteId.GetChatModels,
        description: "Get available chat models based on configured provider",
        tags: ["Chat Settings"],
        querystring: z.object({
          provider: z.enum(["anthropic", "openai"]).optional(),
        }),
        response: constructResponseSchema(ModelsResponseSchema),
      },
    },
    async ({ organizationId, query }, reply) => {
      try {
        const settings =
          await ChatSettingsModel.findByOrganizationId(organizationId);

        if (!settings) {
          return reply.status(404).send({
            error: {
              message: "Chat settings not found",
              type: "not_found",
            },
          });
        }

        // Use query parameter if provided, otherwise use saved provider
        const provider = query.provider || settings.provider || "anthropic";
        const models: Array<{ id: string; name: string; type?: string }> = [];

        if (provider === "anthropic") {
          // Get API key
          if (!settings.anthropicApiKeySecretId) {
            return reply.status(400).send({
              error: {
                message: "Anthropic API key not configured",
                type: "invalid_request",
              },
            });
          }

          const secret = await SecretModel.findById(
            settings.anthropicApiKeySecretId,
          );
          if (!secret?.secret?.anthropicApiKey) {
            return reply.status(400).send({
              error: {
                message: "Anthropic API key not found",
                type: "invalid_request",
              },
            });
          }

          // Fetch models from Anthropic
          const anthropic = new AnthropicProvider({
            apiKey: secret.secret.anthropicApiKey as string,
            baseURL: config.llm.anthropic.baseUrl,
          });

          try {
            const response = await anthropic.models.list();
            models.push(
              ...response.data.map((model) => ({
                id: model.id,
                name: model.display_name || model.id,
                type: model.type,
              })),
            );
          } catch (error) {
            fastify.log.error(
              { error },
              "Failed to fetch models from Anthropic",
            );
            return reply.status(500).send({
              error: {
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to fetch models",
                type: "api_error",
              },
            });
          }
        } else if (provider === "openai") {
          // Get API key
          if (!settings.openaiApiKeySecretId) {
            return reply.status(400).send({
              error: {
                message: "OpenAI API key not configured",
                type: "invalid_request",
              },
            });
          }

          const secret = await SecretModel.findById(
            settings.openaiApiKeySecretId,
          );
          if (!secret?.secret?.openaiApiKey) {
            return reply.status(400).send({
              error: {
                message: "OpenAI API key not found",
                type: "invalid_request",
              },
            });
          }

          // Fetch models from OpenAI
          const openai = new OpenAI({
            apiKey: secret.secret.openaiApiKey as string,
            baseURL: config.llm.openai.baseUrl,
          });

          try {
            const response = await openai.models.list();
            models.push(
              ...response.data
                .filter((model) => model.id.includes("gpt"))
                .map((model) => ({
                  id: model.id,
                  name: model.id,
                })),
            );
          } catch (error) {
            fastify.log.error({ error }, "Failed to fetch models from OpenAI");
            return reply.status(500).send({
              error: {
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to fetch models",
                type: "api_error",
              },
            });
          }
        }

        return reply.send({ models });
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

export default chatModelsRoutes;
