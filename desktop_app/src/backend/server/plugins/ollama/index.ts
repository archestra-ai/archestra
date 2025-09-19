import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import config from '@backend/config';
import OllamaClient from '@backend/ollama/client';
import log from '@backend/utils/logger';

const { requiredModels } = config.ollama;

const OllamaRequiredModelStatusSchema = z.object({
  model: z.string(),
  reason: z.string(),
  installed: z.boolean(),
});

/**
 * Register our zod schemas into the global registry, such that they get output as components in the openapi spec
 * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
 */
z.globalRegistry.add(OllamaRequiredModelStatusSchema, {
  id: 'OllamaRequiredModelStatus',
});

const ollamaRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get status of required models
  fastify.get(
    '/api/ollama/required-models',
    {
      schema: {
        operationId: 'getOllamaRequiredModelsStatus',
        description: 'Get the status of all Ollama required models',
        tags: ['Ollama'],
        response: {
          200: z.object({
            models: z.array(OllamaRequiredModelStatusSchema),
          }),
        },
      },
    },
    async (_request, _reply) => {
      try {
        const { models: installedModels } = await OllamaClient.list();
        const installedModelNames = installedModels.map((m) => m.name);

        return {
          models: requiredModels.map((model) => ({
            ...model,
            installed: installedModelNames.includes(model.model),
          })),
        };
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to get required models status');
        throw new Error('Failed to check model status');
      }
    }
  );

  // Remove/uninstall a model
  fastify.delete(
    '/api/ollama/models/:modelName',
    {
      schema: {
        operationId: 'removeOllamaModel',
        description: 'Remove/uninstall an Ollama model',
        tags: ['Ollama'],
        params: z.object({
          modelName: z.string(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
          400: z.object({
            error: z.string(),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async ({ params: { modelName } }, reply) => {
      try {
        // Check if it's a required model - don't allow removal of required models
        if (requiredModels.some((m) => m.model === modelName)) {
          return reply.code(400).send({
            error: `Cannot remove required model: ${modelName}. This model is needed for app functionality.`,
          });
        }

        await OllamaClient.remove(modelName);

        return reply.code(200).send({
          success: true,
          message: `Model ${modelName} successfully removed`,
        });
      } catch (error) {
        fastify.log.error({ err: error, modelName }, 'Failed to remove model');
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to remove model',
        });
      }
    }
  );

  fastify.post(
    '/api/ollama/pull',
    {
      schema: {
        operationId: 'pullOllamaModel',
        description: 'Pull an Ollama model',
        tags: ['Ollama'],
        body: z.object({
          model: z.string().describe('The model name to pull'),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { model } = request.body;

      try {
        log.info({ model }, 'Starting Ollama model pull with WebSocket progress');

        // This method sends WebSocket progress events
        await OllamaClient.pull({ name: model });

        return reply.send({
          success: true,
          message: `Successfully pulled model ${model}`,
        });
      } catch (error) {
        log.error({ error, model }, 'Failed to pull Ollama model');
        return reply.code(500).send({
          error: `Failed to pull model: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  );
};

export default ollamaRoutes;
