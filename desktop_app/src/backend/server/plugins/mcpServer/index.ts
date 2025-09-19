import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import {
  McpServerConfigSchema,
  McpServerSchema,
  McpServerUserConfigValuesSchema,
} from '@backend/database/schema/mcpServer';
import ExternalMcpClientModel from '@backend/models/externalMcpClient';
import McpRequestLog from '@backend/models/mcpRequestLog';
import McpServerModel, { McpServerInstallSchema } from '@backend/models/mcpServer';
import McpServerSandboxManager from '@backend/sandbox/manager';
import { AvailableToolSchema, McpServerContainerLogsSchema } from '@backend/sandbox/sandboxedMcp';
import { ErrorResponseSchema } from '@backend/schemas';
import { McpOAuthProvider, connectMcpServer } from '@backend/server/plugins/mcp-oauth';
import toolService from '@backend/services/tool';
import log from '@backend/utils/logger';

/**
 * Register our zod schemas into the global registry, such that they get output as components in the openapi spec
 * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
 */
// Register base schemas first - these have no dependencies
z.globalRegistry.add(McpServerConfigSchema, { id: 'McpServerConfig' });
z.globalRegistry.add(McpServerUserConfigValuesSchema, { id: 'McpServerUserConfigValues' });

// Then register schemas that depend on base schemas
z.globalRegistry.add(McpServerSchema, { id: 'McpServer' });
z.globalRegistry.add(McpServerInstallSchema, { id: 'McpServerInstall' });
z.globalRegistry.add(McpServerContainerLogsSchema, { id: 'McpServerContainerLogs' });
z.globalRegistry.add(AvailableToolSchema, { id: 'AvailableTool' });

const mcpServerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/api/mcp_server',
    {
      schema: {
        operationId: 'getMcpServers',
        description: 'Get all installed MCP servers',
        tags: ['MCP Server'],
        response: {
          200: z.array(McpServerSchema),
        },
      },
    },
    async (_request, reply) => {
      const servers = await McpServerModel.getInstalledMcpServers();
      return reply.send(servers);
    }
  );

  fastify.post(
    '/api/mcp_server/install',
    {
      schema: {
        operationId: 'installMcpServer',
        description: 'Install an MCP server. Either from the catalog, or a customer server',
        tags: ['MCP Server'],
        body: McpServerInstallSchema,
        response: {
          200: McpServerSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body }, reply) => {
      try {
        const server = await McpServerModel.installMcpServer(body);
        return reply.code(200).send(server);
      } catch (error: any) {
        log.error('Failed to install MCP server:', error);

        if (error.message?.includes('already installed')) {
          return reply.code(400).send({ error: error.message });
        }

        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.delete(
    '/api/mcp_server/:id',
    {
      schema: {
        operationId: 'uninstallMcpServer',
        description: 'Uninstall MCP server',
        tags: ['MCP Server'],
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
        },
      },
    },
    async ({ params: { id } }, reply) => {
      await McpServerModel.uninstallMcpServer(id);
      return reply.code(200).send({ success: true });
    }
  );

  /**
   * Relevant docs:
   *
   * Fastify reply.hijack() docs: https://fastify.dev/docs/latest/Reference/Reply/#hijack
   * Excluding a route from the openapi spec: https://stackoverflow.com/questions/73950993/fastify-swagger-exclude-certain-routes
   */
  fastify.post(
    '/mcp_proxy/:id',
    {
      schema: {
        hide: true,
        description: 'Proxy requests to the containerized MCP server running in the Archestra.ai sandbox',
        tags: ['MCP Server'],
        params: z.object({
          id: z.string(),
        }),
        body: z
          .object({
            jsonrpc: z.string().optional(),
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string().optional(),
            params: z.any().optional(),
            sessionId: z.string().optional(),
            mcpSessionId: z.string().optional(),
          })
          .passthrough(),
      },
    },
    async ({ params: { id }, body, headers }, reply) => {
      const sandboxedMcpServer = McpServerSandboxManager.getSandboxedMcpServer(id);
      if (!sandboxedMcpServer) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      const { name: mcpServerName } = sandboxedMcpServer.mcpServer;

      // Create MCP request log entry
      const requestId = uuidv4();
      const startTime = Date.now();
      let responseBody: string | null = null;
      let statusCode = 200;
      let errorMessage: string | null = null;

      try {
        // Hijack the response to handle streaming manually!
        reply.hijack();

        // Set up streaming response headers!
        reply.raw.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });

        // Create a custom writable stream to capture the response
        const responseChunks: Buffer[] = [];
        const originalWrite = reply.raw.write.bind(reply.raw);
        const originalEnd = reply.raw.end.bind(reply.raw);

        reply.raw.write = function (chunk: any, encoding?: any) {
          if (chunk) {
            responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          return originalWrite(chunk, encoding);
        };

        reply.raw.end = function (chunk?: any, encoding?: any) {
          if (chunk) {
            responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          responseBody = Buffer.concat(responseChunks).toString('utf-8');

          // Log the successful request
          McpRequestLog.create({
            requestId,
            sessionId: body.sessionId || null,
            mcpSessionId: body.mcpSessionId || null,
            serverName: mcpServerName || id,
            clientInfo: {
              userAgent: headers['user-agent'],
              clientName: 'Archestra Desktop App',
              clientVersion: '0.0.1',
              clientPlatform: process.platform,
            },
            method: body.method || null,
            requestHeaders: headers as Record<string, string>,
            requestBody: JSON.stringify(body),
            responseBody,
            responseHeaders: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache',
            },
            statusCode,
            errorMessage: null,
            durationMs: Date.now() - startTime,
          }).catch((err) => {
            fastify.log.error('Failed to create MCP request log:', err);
          });

          return originalEnd(chunk, encoding);
        };

        // Streamable HTTP servers now connect directly, so proxy only handles stdio servers
        if (sandboxedMcpServer.isStreamableHttpServer()) {
          throw new Error('Streamable HTTP servers should connect directly, not through proxy');
        }

        // Stream the request to the container via stdio for stdio-based MCP servers
        await sandboxedMcpServer.streamToContainer(body, reply.raw);

        // Return undefined when hijacking to prevent Fastify from sending response
        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : 'No stack trace';

        statusCode = 500;
        errorMessage = errorMsg;

        fastify.log.error(`Error proxying to MCP server ${id}: ${errorMsg}`);
        fastify.log.error(`Error stack trace: ${errorStack}`);

        // Log the failed request
        await McpRequestLog.create({
          requestId,
          sessionId: body.sessionId || null,
          mcpSessionId: body.mcpSessionId || null,
          serverName: mcpServerName || id,
          clientInfo: {
            userAgent: headers['user-agent'],
            clientName: 'Archestra Desktop App',
            clientVersion: '0.0.1',
            clientPlatform: process.platform,
          },
          method: body.method || null,
          requestHeaders: headers as Record<string, string>,
          requestBody: JSON.stringify(body),
          responseBody: JSON.stringify({ error: errorMsg }),
          responseHeaders: {},
          statusCode,
          errorMessage,
          durationMs: Date.now() - startTime,
        });

        // If we haven't sent yet, we can still send error response
        if (!reply.sent) {
          return reply.code(500).send({
            error: error instanceof Error ? error.message : 'Failed to proxy request to MCP server',
          });
        } else if (!reply.raw.headersSent) {
          // If already hijacked, try to write error to raw response
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'Failed to proxy request to MCP server',
            })
          );
        }
      }
    }
  );

  fastify.get(
    '/mcp_proxy/:id/logs',
    {
      schema: {
        operationId: 'getMcpServerLogs',
        description: 'Get logs for a specific MCP server container',
        tags: ['MCP Server'],
        params: z.object({
          id: z.string(),
        }),
        querystring: z.object({
          lines: z.coerce.number().optional().default(100),
        }),
        response: {
          200: McpServerContainerLogsSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id }, query: { lines } }, reply) => {
      const sandboxedMcpServer = McpServerSandboxManager.getSandboxedMcpServer(id);
      if (!sandboxedMcpServer) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      try {
        const logs = await sandboxedMcpServer.getMcpServerLogs(lines);
        return reply.send(logs);
      } catch (error) {
        fastify.log.error(`Error getting logs for MCP server ${id}: ${error}`);
        return reply.code(404).send({
          error: error instanceof Error ? error.message : 'Failed to get logs',
        });
      }
    }
  );

  fastify.get(
    '/api/mcp_server/tools',
    {
      schema: {
        operationId: 'getAvailableTools',
        description: 'Get all available tools from connected MCP servers',
        tags: ['MCP Server'],
        response: {
          200: z.array(AvailableToolSchema),
        },
      },
    },
    async (_request, reply) => {
      // Get tools from both sandboxed servers and Archestra MCP server
      return reply.send(toolService.getAllAvailableTools());
    }
  );

  // Simple OAuth install endpoint - mirrors connectMcpServer from linear-mcp-oauth-minimal.ts
  fastify.post(
    '/api/mcp_server/oauth_install',
    {
      schema: {
        operationId: 'installMcpServerWithOauth',
        description: 'Install MCP server with OAuth authentication',
        tags: ['MCP Server'],
        body: z.object({
          installData: McpServerInstallSchema,
        }),
        response: {
          200: z.object({
            server: McpServerSchema,
          }),
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body }, reply) => {
      log.info('OAuth install request body:', JSON.stringify(body, null, 2));
      const { installData } = body;

      try {
        log.info('OAuth install request received:', {
          installDataKeys: Object.keys(installData),
          hasOauthConfig: !!installData.oauthConfig,
          displayName: installData.displayName,
        });

        if (!installData.oauthConfig) {
          log.warn('OAuth install rejected: oauthConfig missing');
          return reply.code(400).send({ error: 'oauthConfig is required for OAuth installation' });
        }

        // Use OAuth config directly from catalog
        const config = installData.oauthConfig;

        log.info('MCP OAuth config loaded:', {
          configName: config.name,
          isGenericOAuth: !!config.generic_oauth,
          hasClientId: !!config.client_id,
          serverUrl: config.server_url,
          requiresProxy: !!config.requires_proxy,
        });

        // Check if this uses generic OAuth flow - redirect to generic OAuth endpoint
        if (config.generic_oauth) {
          log.info('Redirecting to generic OAuth endpoint for:', config.name);
          return reply.code(400).send({
            error: 'Generic OAuth servers should use /api/mcp_server/start_oauth endpoint',
          });
        }

        // Generate server ID
        const serverId = installData.id || uuidv4();

        // Check if this is a remote server (has remote_url from catalog)
        const isRemoteServer = !!installData.remote_url;
        const remoteUrl = installData.remote_url;

        log.info(`Installing ${isRemoteServer ? 'remote' : 'local'} MCP server: ${installData.displayName}`);
        log.info('Install data keys:', Object.keys(installData));
        log.info('Remote URL detection:', {
          hasRemoteUrl: !!installData.remote_url,
          remoteUrl: installData.remote_url,
          isRemoteServer,
        });

        if (isRemoteServer) {
          log.info(`Remote URL: ${remoteUrl}`);
        }

        // Create placeholder MCP server record with oauth_pending status
        // This allows OAuth provider to save client info during the flow
        await McpServerModel.create({
          id: serverId,
          name: installData.displayName,
          serverConfig: installData.serverConfig,
          userConfigValues: installData.userConfigValues || null,
          serverType: isRemoteServer ? 'remote' : 'local', // Set server type based on remote_url
          remoteUrl: remoteUrl, // Store remote_url in separate column
          oauthConfig: installData.oauthConfig ? JSON.stringify(installData.oauthConfig) : null, // Include OAuth config from catalog
          status: 'oauth_pending',
          oauthTokens: null,
          oauthClientInfo: null,
          oauthServerMetadata: null,
          oauthResourceMetadata: null,
          createdAt: new Date().toISOString(),
        });

        try {
          // Perform OAuth and get tokens
          const { client } = await connectMcpServer(config, serverId, remoteUrl);

          // Close the test connection
          await client.close();

          // Get tokens from the provider for installation
          const oauthProvider = new McpOAuthProvider(config, serverId);
          await oauthProvider.init();

          const tokens = await oauthProvider.tokens();
          const clientInfo = await oauthProvider.clientInformation();

          if (!tokens) {
            // Clean up placeholder record on failure
            await McpServerModel.update(serverId, { status: 'failed' });
            return reply.code(500).send({ error: 'Failed to obtain OAuth tokens' });
          }

          // Update server record with complete OAuth data and installed status
          const [server] = await McpServerModel.update(serverId, {
            status: 'installed',
            oauthTokens: tokens,
            oauthClientInfo: clientInfo,
          });

          // For remote servers, start the remote server immediately
          // For local servers, start container as usual
          try {
            if (isRemoteServer) {
              log.info(`Remote server ${server.name} installed successfully - starting remote server`);

              await McpServerSandboxManager.startServer(server);
              // Also sync external clients
              await ExternalMcpClientModel.syncAllConnectedExternalMcpClients();
            } else {
              // Start the MCP server container for local servers
              await McpServerModel.startServerAndSyncAllConnectedExternalMcpClients(server);
            }

            log.info(`OAuth MCP server ${server.name} started successfully`);
          } catch (startupError) {
            log.error(`Failed to start OAuth MCP server ${server.name} after successful OAuth:`, startupError);

            // Rollback server status to 'failed' if startup fails
            await McpServerModel.update(serverId, {
              status: 'failed',
            });

            // Clean up the server from sandbox manager if it was registered
            try {
              await McpServerSandboxManager.removeMcpServer(serverId);
            } catch (cleanupError) {
              log.warn('Failed to clean up server from sandbox manager:', cleanupError);
            }

            return reply.code(500).send({
              error: `OAuth completed successfully but server startup failed: ${startupError instanceof Error ? startupError.message : 'Unknown startup error'}`,
            });
          }

          return reply.send({ server });
        } catch (oauthError) {
          // Clean up placeholder record on OAuth failure
          await McpServerModel.update(serverId, { status: 'failed' });
          throw oauthError;
        }
      } catch (error) {
        log.error('OAuth install failed:', error);
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'OAuth install failed',
        });
      }
    }
  );
};

export default mcpServerRoutes;
