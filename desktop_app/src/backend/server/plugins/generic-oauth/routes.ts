import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import { McpServerSchema } from '@backend/database/schema/mcpServer';
import McpServerModel, { McpServerInstallSchema } from '@backend/models/mcpServer';
import { ErrorResponseSchema } from '@backend/schemas';
import { type OAuthServerConfig } from '@backend/schemas/oauth-config';
import log from '@backend/utils/logger';

import { completeGenericOAuthFlow, startGenericOAuthFlow } from './flow';

/**
 * Handle generic OAuth installation for providers that don't support MCP SDK
 */
async function handleGenericOAuthInstall(
  config: OAuthServerConfig,
  installData: z.infer<typeof McpServerInstallSchema>,
  reply: any
) {
  const serverId = installData.id || uuidv4();

  try {
    log.info(`Starting generic OAuth installation for ${installData.displayName}`);

    // Create placeholder MCP server record with oauth_pending status
    // Store the OAuth config in oauthClientInfo for retrieval during callback
    const placeholderServer = await McpServerModel.create({
      id: serverId,
      name: installData.displayName,
      serverConfig: installData.serverConfig,
      userConfigValues: installData.userConfigValues || null,
      serverType: installData.serverType || 'local',
      remoteUrl: installData.remote_url || null,
      status: 'oauth_pending',
      oauthTokens: null,
      oauthClientInfo: {
        client_id: config.client_id,
        client_secret: config.client_secret,
        generic_oauth_config: config,
      }, // Store config for callback
      oauthServerMetadata: null,
      oauthResourceMetadata: null,
      createdAt: new Date().toISOString(),
    });

    // Start generic OAuth flow
    const authUrl = await startGenericOAuthFlow(config, serverId);

    log.info(`Generic OAuth flow started, auth URL: ${authUrl}`);

    return reply.send({
      server: placeholderServer[0],
      authUrl,
      message: 'Generic OAuth flow started - complete authorization in browser',
    });
  } catch (error) {
    log.error('Generic OAuth install failed:', error);

    // Clean up placeholder record on failure
    try {
      await McpServerModel.update(serverId, { status: 'failed' });
    } catch (cleanupError) {
      log.error('Failed to cleanup placeholder server:', cleanupError);
    }

    return reply.code(500).send({
      error: error instanceof Error ? error.message : 'Generic OAuth install failed',
    });
  }
}

const genericOAuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Generic OAuth install endpoint
  fastify.post(
    '/api/mcp_server/start_oauth',
    {
      schema: {
        operationId: 'startGenericOAuth',
        description: 'Start generic OAuth flow for MCP server installation',
        tags: ['OAuth'],
        body: z.object({
          installData: McpServerInstallSchema,
        }),
        response: {
          200: z.object({
            server: McpServerSchema,
            authUrl: z.string(),
            message: z.string(),
          }),
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body }, reply) => {
      const { installData } = body;

      try {
        log.info('Generic OAuth start request received:', {
          installDataKeys: Object.keys(installData),
          hasOauthConfig: !!installData.oauthConfig,
          displayName: installData.displayName,
        });

        if (!installData.oauthConfig) {
          log.warn('Generic OAuth start rejected: oauthConfig missing');
          return reply.code(400).send({ error: 'oauthConfig is required for OAuth installation' });
        }

        // Use OAuth config directly from catalog
        const config = installData.oauthConfig;

        log.info('Generic OAuth config loaded:', {
          configName: config.name,
          isGenericOAuth: !!config.generic_oauth,
          hasClientId: !!config.client_id,
          serverUrl: config.server_url,
          requiresProxy: !!config.requires_proxy,
          hasAccessTokenEnvVar: !!config.access_token_env_var,
        });

        // Only handle generic OAuth flow here
        if (!config.generic_oauth) {
          log.warn('Generic OAuth start rejected: not a generic OAuth flow');
          return reply.code(400).send({ error: 'This endpoint only handles generic OAuth flows' });
        }

        return await handleGenericOAuthInstall(config, installData, reply);
      } catch (error) {
        log.error('Generic OAuth start failed:', error);
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Generic OAuth start failed',
        });
      }
    }
  );

  // Generic OAuth callback endpoint
  fastify.post(
    '/api/mcp_server/complete_oauth',
    {
      schema: {
        operationId: 'completeGenericOAuth',
        description: 'Complete generic OAuth flow with authorization code',
        tags: ['OAuth'],
        body: z.object({
          code: z.string(),
          state: z.string(),
        }),
        response: {
          200: z.object({
            server: McpServerSchema,
            message: z.string(),
          }),
          400: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async ({ body }, reply) => {
      const { code, state } = body;

      try {
        // Find the server with oauth_pending status (should be unique for the state)
        const allServers = await McpServerModel.getAll();
        const server = allServers.find((s) => s.status === 'oauth_pending');

        if (!server) {
          return reply.code(400).send({ error: 'No server found with oauth_pending status' });
        }

        const serverId = server.id;

        // Retrieve the OAuth config from the stored client info
        const storedConfig = server.oauthClientInfo?.generic_oauth_config;
        if (!storedConfig) {
          return reply.code(400).send({ error: 'OAuth config not found in server record' });
        }

        // Complete the generic OAuth flow (this handles token storage, status update, and server startup)
        const tokens = await completeGenericOAuthFlow(storedConfig as OAuthServerConfig, serverId, code, state);

        // Get the updated server record
        const servers = await McpServerModel.getById(serverId);
        const updatedServer = servers[0];

        return reply.send({
          server: updatedServer,
          message: 'Generic OAuth flow completed successfully',
        });
      } catch (error) {
        log.error('Generic OAuth callback failed:', error);
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Generic OAuth callback failed',
        });
      }
    }
  );
};

export default genericOAuthRoutes;
