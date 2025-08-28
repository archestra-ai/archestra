import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { McpServerCategorySchema } from '@schemas';

const categoryRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/category',
    {
      schema: {
        operationId: 'getCategories',
        description: 'Get all available MCP server categories',
        tags: ['Category'],
        response: {
          200: z.object({
            categories: z.array(McpServerCategorySchema),
          }),
        },
      },
    },
    async (_request, _reply) => ({ categories: McpServerCategorySchema.options })
  );
};

export default categoryRoutes;
