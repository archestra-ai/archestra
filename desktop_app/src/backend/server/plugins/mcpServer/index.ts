import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { request } from 'undici';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import {
  McpServerConfigSchema,
  McpServerSchema,
  McpServerUserConfigValuesSchema,
} from '@backend/database/schema/mcpServer';
import toolAggregator from '@backend/llms/toolAggregator';
import McpRequestLog from '@backend/models/mcpRequestLog';
import McpServerModel, { McpServerInstallSchema } from '@backend/models/mcpServer';
import McpServerSandboxManager from '@backend/sandbox/manager';
import { AvailableToolSchema, McpServerContainerLogsSchema } from '@backend/sandbox/sandboxedMcp';
import { ErrorResponseSchema } from '@backend/schemas';
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

/**
 * Proxy HTTP request to streamable HTTP MCP server
 */
async function proxyHttpRequest(
  body: any,
  headers: Record<string, any>,
  mcpServer: any,
  targetPort: number,
  responseStream: NodeJS.WritableStream
): Promise<void> {
  // Get the streamable_http_url from OAuth config and replace port
  let oauthConfig = null;
  try {
    oauthConfig = mcpServer.oauthConfig 
      ? (typeof mcpServer.oauthConfig === 'string' 
         ? JSON.parse(mcpServer.oauthConfig) 
         : mcpServer.oauthConfig)
      : null;
  } catch (error) {
    log.error(`[HTTP Proxy] Failed to parse oauthConfig:`, error);
    log.error(`[HTTP Proxy] oauthConfig type:`, typeof mcpServer.oauthConfig);
    log.error(`[HTTP Proxy] oauthConfig value:`, mcpServer.oauthConfig);
  }
  
  const streamableHttpUrl = oauthConfig?.streamable_http_url;
  
  // Get OAuth tokens if available
  let oauthTokens = null;
  try {
    oauthTokens = mcpServer.oauthTokens 
      ? (typeof mcpServer.oauthTokens === 'string' 
         ? JSON.parse(mcpServer.oauthTokens) 
         : mcpServer.oauthTokens)
      : null;
  } catch (error) {
    log.error(`[HTTP Proxy] Failed to parse oauthTokens:`, error);
    log.error(`[HTTP Proxy] oauthTokens type:`, typeof mcpServer.oauthTokens);
    log.error(`[HTTP Proxy] oauthTokens value:`, mcpServer.oauthTokens);
  }
  if (!streamableHttpUrl) {
    throw new Error('streamable_http_url not found in OAuth config');
  }
  
  // Parse the URL and replace the port
  const url = new URL(streamableHttpUrl);
  const originalPort = url.port;
  url.port = targetPort.toString();
  const targetUrl = url.toString();
  
  log.info(`[HTTP Proxy] Original URL: ${streamableHttpUrl} (port: ${originalPort})`);
  log.info(`[HTTP Proxy] Target URL: ${targetUrl}`);
  log.info(`[HTTP Proxy] Parsed URL components:`, {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname
  });
  log.info(`[HTTP Proxy] Request method: POST`);
  log.info(`[HTTP Proxy] Incoming headers:`, Object.keys(headers));
  log.info(`[HTTP Proxy] Request body:`, JSON.stringify(body));
  
  try {
    // First, let's test basic connectivity
    log.info(`[HTTP Proxy] Testing connectivity to ${url.hostname}:${url.port}...`);
    
    // Simple connectivity test with OAuth token if available
    try {
      const testHeaders: Record<string, string> = {
        'User-Agent': 'Archestra-Desktop-App/1.0.0',
      };
      
      if (oauthTokens?.access_token) {
        testHeaders['Authorization'] = `Bearer ${oauthTokens.access_token}`;
        log.info(`[HTTP Proxy] Using OAuth token for connectivity test`);
      }
      
      const testResponse = await request(`http://${url.hostname}:${url.port}/`, {
        method: 'GET',
        headers: testHeaders,
        headersTimeout: 2000,
        bodyTimeout: 2000,
      });
      log.info(`[HTTP Proxy] Connectivity test successful - Status: ${testResponse.statusCode}`);
      
      // Also test the exact MCP endpoint path
      if (url.pathname !== '/') {
        log.info(`[HTTP Proxy] Testing MCP endpoint path: ${url.pathname}`);
        try {
          const endpointTest = await request(`http://${url.hostname}:${url.port}${url.pathname}`, {
            method: 'GET',
            headers: testHeaders,
            headersTimeout: 2000,
            bodyTimeout: 2000,
          });
          log.info(`[HTTP Proxy] MCP endpoint test successful - Status: ${endpointTest.statusCode}`);
        } catch (endpointError) {
          log.warn(`[HTTP Proxy] MCP endpoint test failed:`, endpointError);
        }
      }
    } catch (connectError) {
      log.error(`[HTTP Proxy] Connectivity test failed:`, connectError);
      log.error(`[HTTP Proxy] This indicates the container HTTP server is not responding on ${url.hostname}:${url.port}`);
    }
    
    log.info(`[HTTP Proxy] Initiating MCP request to ${targetUrl}...`);
    
    // Prepare headers with OAuth token if available
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Archestra-Desktop-App/1.0.0',
    };
    
    // Add OAuth token if available
    if (oauthTokens?.access_token) {
      requestHeaders['Authorization'] = `Bearer ${oauthTokens.access_token}`;
      log.info(`[HTTP Proxy] Added OAuth Bearer token to request headers`);
    } else if (headers.authorization) {
      requestHeaders['Authorization'] = headers.authorization;
      log.info(`[HTTP Proxy] Using authorization header from request`);
    } else {
      log.warn(`[HTTP Proxy] No OAuth token or authorization header available`);
    }
    
    log.info(`[HTTP Proxy] Final request headers:`, Object.keys(requestHeaders));

    log.info(`[HTTP Proxy] Making HTTP request with timeout settings...`);
    
    const response = await request(targetUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      headersTimeout: 10000, // 10 second timeout
      bodyTimeout: 10000,    // 10 second timeout
    });

    log.info(`[HTTP Proxy] Response received - Status: ${response.statusCode}`);
    log.info(`[HTTP Proxy] Response headers:`, response.headers);

    // Stream the response back
    response.body.pipe(responseStream);
    
    // Handle response completion
    return new Promise((resolve, reject) => {
      response.body.on('end', () => {
        log.info(`[HTTP Proxy] Response streaming completed successfully`);
        resolve();
      });
      response.body.on('error', (error) => {
        log.error(`[HTTP Proxy] Response streaming error:`, error);
        reject(error);
      });
    });
  } catch (error) {
    log.error(`[HTTP Proxy] Failed to proxy HTTP request to ${targetUrl}:`, error);
    
    // Log more details about the error
    if (error && typeof error === 'object') {
      const errorObj = error as any;
      log.error(`[HTTP Proxy] Error details:`, {
        name: errorObj.name,
        message: errorObj.message,
        code: errorObj.code,
        errno: errorObj.errno,
        syscall: errorObj.syscall,
        address: errorObj.address,
        port: errorObj.port,
        hostname: errorObj.hostname,
        stack: errorObj.stack?.split('\n').slice(0, 3).join('\n'), // First 3 lines of stack
      });
      
      // Check for specific error types
      if (errorObj.code === 'ECONNREFUSED') {
        log.error(`[HTTP Proxy] Connection refused - server not listening on ${url.hostname}:${url.port}`);
      } else if (errorObj.code === 'ETIMEDOUT') {
        log.error(`[HTTP Proxy] Connection timeout - server took too long to respond`);
      } else if (errorObj.code === 'ENOTFOUND') {
        log.error(`[HTTP Proxy] DNS resolution failed for ${url.hostname}`);
      } else if (errorObj.message?.includes('other side closed')) {
        log.error(`[HTTP Proxy] Server closed connection unexpectedly - possible auth/protocol issue`);
      }
    }
    
    throw error;
  }
}

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
        fastify.log.info(`Proxying request to MCP server ${id}: ${JSON.stringify(body)}`);

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

        // Check if this is a streamable HTTP server
        if (sandboxedMcpServer.isStreamableHttpServer()) {
          const assignedPort = sandboxedMcpServer.getAssignedHttpPort();
          fastify.log.info(`[MCP Proxy] Server ${id} is streamable HTTP server`);
          fastify.log.info(`[MCP Proxy] Assigned port: ${assignedPort}`);
          
          if (assignedPort) {
            fastify.log.info(`[MCP Proxy] Proxying HTTP request to streamable server on port ${assignedPort}`);
            // Proxy HTTP request directly to the container's assigned port
            await proxyHttpRequest(body, headers, sandboxedMcpServer.mcpServer, assignedPort, reply.raw);
          } else {
            fastify.log.error(`[MCP Proxy] Streamable HTTP server port not found for ${id}`);
            throw new Error('Streamable HTTP server port not found');
          }
        } else {
          // Stream the request to the container via stdio!
          await sandboxedMcpServer.streamToContainer(body, reply.raw);
        }

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
      return reply.send(toolAggregator.getAllAvailableTools());
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
        const placeholderServer = await McpServerModel.create({
          id: serverId,
          name: installData.displayName,
          serverConfig: installData.serverConfig.mcp_config || installData.serverConfig,
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
          const { connectMcpServer } = await import('@backend/server/plugins/mcp-oauth');
          const { client, accessToken } = await connectMcpServer(config, serverId, remoteUrl);

          // Close the test connection
          await client.close();

          // Get tokens from the provider for installation
          const { McpOAuthProvider } = await import('@backend/server/plugins/mcp-oauth');
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
              // Import McpServerSandboxManager to start the remote server
              const { default: McpServerSandboxManager } = await import('@backend/sandbox/manager');
              await McpServerSandboxManager.startServer(server);
              // Also sync external clients
              const { default: ExternalMcpClientModel } = await import('@backend/models/externalMcpClient');
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
              const { default: McpServerSandboxManager } = await import('@backend/sandbox/manager');
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
