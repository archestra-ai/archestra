import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import config from '@backend/config';
import OllamaClient from '@backend/ollama/client';

const {
  ollama: { requiredModels: ollamaRequiredModels },
} = config;

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

const ollamaMetadataRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get status of required models
  fastify.get(
    '/api/ollama/required-models',
    {
      schema: {
        operationId: 'getOllamaRequiredModelsStatus',
        description: 'Get the status of all Ollama required models',
        tags: ['MCP Server'],
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
          models: ollamaRequiredModels.map((model) => ({
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
};

export default ollamaMetadataRoutes;
