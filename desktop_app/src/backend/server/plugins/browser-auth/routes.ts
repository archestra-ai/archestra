/**
 * Browser Authentication API Routes
 *
 * Handles cross-process communication for browser authentication
 * between main process and backend server
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ErrorResponseSchema } from '@backend/schemas';
import log from '@backend/utils/logger';

// Import the storeAuthorizationCode function from the provider
import { storeAuthorizationCode } from '../mcp-oauth/provider';

/**
 * Request schema for storing authorization code
 */
const StoreCodeRequestSchema = z.object({
  state: z.string().min(1, 'State parameter is required'),
  code: z.string().min(1, 'Authorization code is required'),
});

const oauthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Store authorization code from main process deep link handler
  fastify.post(
    '/api/oauth/store-code',
    {
      schema: {
        operationId: 'storeOAuthCode',
        description: 'Store OAuth authorization code from deep link callback (internal API)',
        tags: ['OAuth'],
        body: StoreCodeRequestSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body }, reply) => {
      try {
        const { state, code } = body;

        log.info('📨 Received authorization code storage request from main process');
        log.info(`📋 State: ${state.substring(0, 10)}...`);
        log.info(`🔐 Code: ${code.substring(0, 20)}...`);

        // Store the authorization code using the existing function
        storeAuthorizationCode(state, code);

        return reply.send({
          success: true,
          message: 'Authorization code stored successfully',
        });
      } catch (error) {
        log.error('❌ Failed to store authorization code:', error);
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to store authorization code',
        });
      }
    }
  );
};

export default oauthRoutes;
