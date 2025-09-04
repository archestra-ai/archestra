import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import McpRequestLogModel, {
  McpRequestLogFilterStatusSchema,
  McpRequestLogFiltersSchema,
  McpRequestLogSchema,
  McpRequestLogStatsSchema,
} from '@backend/models/mcpRequestLog';
import { ErrorResponseSchema, StringNumberIdSchema } from '@backend/schemas';

export const McpRequestLogFiltersWithPaginationSchema = McpRequestLogFiltersSchema.extend({
  /**
   * See https://github.com/colinhacks/zod/discussions/330#discussioncomment-7679874
   */
  page: z.preprocess((x) => (x ? x : undefined), z.coerce.number().int().min(1).default(1)).optional(),
  pageSize: z.preprocess((x) => (x ? x : undefined), z.coerce.number().int().min(1).max(100).default(50)).optional(),
});

/**
 * Register our zod schemas into the global registry, such that they get output as components in the openapi spec
 * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
 */
z.globalRegistry.add(McpRequestLogSchema, { id: 'McpRequestLog' });
z.globalRegistry.add(McpRequestLogStatsSchema, { id: 'McpRequestLogStats' });
z.globalRegistry.add(McpRequestLogFilterStatusSchema, { id: 'McpRequestLogFilterStatus' });
/**
 * NOTE: for some reason, it fails to output these 👇 two components in the openapi spec because of this:
 *
 * ❯ pnpm tsx openapi/archestra/api/generate-openapi.ts
 *   TypeError: Cannot read properties of undefined (reading 'type')
 *       at resolveLocalRef (./node_modules/@fastify/swagger/lib/util/resolve-local-ref.js:7:18)
 *       at plainJsonObjectToOpenapi3 (./node_modules/@fastify/swagger/lib/spec/openapi/utils.js:134:43)
 *       at resolveCommonParams (./node_modules/@fastify/swagger/lib/spec/openapi/utils.js:303:15)
 *       at prepareOpenapiMethod (./node_modules/@fastify/swagger/lib/spec/openapi/utils.js:473:29)
 *       at Object.swagger (./node_modules/@fastify/swagger/lib/spec/openapi/index.js:52:29)
 *       at generateOpenAPISpec (./openapi/archestra/api/generate-openapi.ts:68:20)
 *       at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
 */
// z.globalRegistry.add(McpRequestLogFiltersSchema, { id: 'McpRequestLogFilters' });
// z.globalRegistry.add(McpRequestLogFiltersWithPaginationSchema, { id: 'McpRequestLogFiltersWithPagination' });

const mcpRequestLogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/api/mcp_request_log',
    {
      schema: {
        operationId: 'getMcpRequestLogs',
        description: 'Get MCP request logs with filtering and pagination',
        tags: ['MCP Request Log'],
        querystring: McpRequestLogFiltersWithPaginationSchema,
        response: {
          200: z.object({
            data: z.array(McpRequestLogSchema),
            total: z.number(),
            page: z.number(),
            pageSize: z.number(),
          }),
        },
      },
    },
    async ({ query: { page = 1, pageSize = 50, ...filters } }, reply) => {
      const result = await McpRequestLogModel.getRequestLogs(filters, page, pageSize);
      return reply.send({
        data: result.logs,
        total: result.totalPages * pageSize,
        page,
        pageSize,
      });
    }
  );

  fastify.get(
    '/api/mcp_request_log/:id',
    {
      schema: {
        operationId: 'getMcpRequestLogById',
        description: 'Get a single MCP request log by ID',
        tags: ['MCP Request Log'],
        params: z.object({
          id: StringNumberIdSchema,
        }),
        response: {
          200: McpRequestLogSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id } }, reply) => {
      const log = await McpRequestLogModel.getRequestLogById(id);
      if (!log) {
        return reply.code(404).send({ error: 'Request log not found' });
      }

      return reply.send(log);
    }
  );

  fastify.get(
    '/api/mcp_request_log/stats',
    {
      schema: {
        operationId: 'getMcpRequestLogStats',
        description: 'Get MCP request log statistics',
        tags: ['MCP Request Log'],
        querystring: McpRequestLogFiltersSchema,
        response: {
          200: McpRequestLogStatsSchema,
        },
      },
    },
    async ({ query }, reply) => {
      const stats = await McpRequestLogModel.getRequestLogStats(query);
      return reply.send(stats);
    }
  );

  fastify.delete(
    '/api/mcp_request_log',
    {
      schema: {
        operationId: 'clearMcpRequestLogs',
        description: 'Clear MCP request logs',
        tags: ['MCP Request Log'],
        body: z.object({
          clearAll: z.boolean(),
        }),
        response: {
          200: z.object({ cleared: z.number() }),
        },
      },
    },
    async ({ body: { clearAll } }, reply) => {
      /**
       * If the user doesn't specify to clear all logs, we'll clear logs older than 7 days by default
       */
      const cleared = clearAll ? await McpRequestLogModel.clearAllLogs() : await McpRequestLogModel.cleanupOldLogs(7);
      return reply.send({ cleared });
    }
  );
};

export default mcpRequestLogRoutes;
