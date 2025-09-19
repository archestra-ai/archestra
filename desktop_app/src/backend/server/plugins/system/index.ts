import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { LOGS_DIRECTORY } from '@backend/utils/paths';

const systemRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Simple endpoint without complex schema for now
  fastify.get('/api/system/backend-logs', async (request, reply) => {
    try {
      // Get query params
      const query = request.query as { lines?: string };
      const lines = parseInt(query?.lines || '1000', 10);
      const logPath = path.join(LOGS_DIRECTORY, 'main.log');

      // Check if log file exists
      if (!fs.existsSync(logPath)) {
        return reply.send({ logs: 'No log file found', error: null });
      }

      // Read the file
      const fileContent = fs.readFileSync(logPath, 'utf-8');
      const logLines = fileContent.split('\n');

      // Get the last N lines
      const lastLines = logLines.slice(-lines);
      const logs = lastLines.join('\n');

      return reply.send({ logs, error: null });
    } catch (error) {
      fastify.log.error('Failed to read backend logs:', error);
      return reply.code(500).send({
        logs: '',
        error: error instanceof Error ? error.message : 'Failed to read logs',
      });
    }
  });
};

export default systemRoutes;
