import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import ollamaClient from '@backend/ollama/client';
import log from '@backend/utils/logger';

const PullModelRequestSchema = z.object({
  model: z.string().describe('The model name to pull'),
});

const PullModelResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

const PullModelErrorSchema = z.object({
  error: z.string(),
});

const ollamaDownloadRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    '/api/ollama/pull',
    {
      schema: {
        body: PullModelRequestSchema,
        response: {
          200: PullModelResponseSchema,
          500: PullModelErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { model } = request.body;

      try {
        log.info({ model }, 'Starting Ollama model pull with WebSocket progress');

        // This method sends WebSocket progress events
        await ollamaClient.pull({ name: model });

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

export default ollamaDownloadRoutes;
