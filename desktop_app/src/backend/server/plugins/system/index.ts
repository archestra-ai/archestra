import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { LOGS_DIRECTORY } from '@backend/utils/paths';

// Define schemas
const BackendLogsQuerySchema = z.object({
  lines: z
    .string()
    .optional()
    .default('1000')
    .transform((val) => parseInt(val, 10))
    .describe('Number of lines to return from the end of the log file'),
});

const BackendLogsResponseSchema = z.object({
  logs: z.string().describe('The log content or error message'),
  error: z.string().nullable().describe('Error message if failed to read logs'),
});

// Register the schema in the global registry
z.globalRegistry.add(BackendLogsResponseSchema, { id: 'BackendLogsResponse' });

const systemRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/api/system/backend-logs',
    {
      schema: {
        operationId: 'getSystemBackendLogs',
        description: 'Get backend log file content',
        tags: ['System'],
        querystring: BackendLogsQuerySchema,
        response: {
          200: BackendLogsResponseSchema,
          500: BackendLogsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { lines } = request.query;
        const logPath = path.join(LOGS_DIRECTORY, 'main.log');

        // Check if log file exists
        if (!fs.existsSync(logPath)) {
          return reply.code(200).send({ logs: 'No log file found', error: null });
        }

        // Read the file
        const fileContent = fs.readFileSync(logPath, 'utf-8');
        const logLines = fileContent.split('\n');

        // Get the last N lines
        const lastLines = logLines.slice(-lines);
        const logs = lastLines.join('\n');

        return reply.code(200).send({ logs, error: null });
      } catch (error) {
        fastify.log.error('Failed to read backend logs:', error);
        return reply.code(500).send({
          logs: '',
          error: error instanceof Error ? error.message : 'Failed to read logs',
        });
      }
    }
  );
};

export default systemRoutes;
