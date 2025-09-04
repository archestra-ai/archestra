import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import McpServerSandboxManager from '@backend/sandbox/manager';
import { ErrorResponseSchema } from '@backend/schemas';
import log from '@backend/utils/logger';

// Define response schema
const SandboxActionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

// Register schemas in global registry for OpenAPI generation
z.globalRegistry.add(SandboxActionResponseSchema, { id: 'SandboxActionResponse' });

const sandboxRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    '/api/sandbox/restart',
    {
      schema: {
        operationId: 'restartSandbox',
        description: 'Restart the Archestra MCP Sandbox (podman machine + all MCP servers)',
        tags: ['Sandbox'],
        response: {
          200: SandboxActionResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        await McpServerSandboxManager.restart();
        return reply.send({
          success: true,
          message: 'Sandbox restart initiated successfully',
        });
      } catch (error: any) {
        log.error('Failed to restart sandbox:', error);
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to restart sandbox',
        });
      }
    }
  );

  fastify.post(
    '/api/sandbox/reset',
    {
      schema: {
        operationId: 'resetSandbox',
        description: 'Clean/purge all data (uninstall all MCP servers + reset podman machine)',
        tags: ['Sandbox'],
        response: {
          200: SandboxActionResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        await McpServerSandboxManager.reset();
        return reply.send({
          success: true,
          message: 'Sandbox reset completed successfully',
        });
      } catch (error: any) {
        log.error('Failed to reset sandbox:', error);
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to reset sandbox',
        });
      }
    }
  );
};

export default sandboxRoutes;
