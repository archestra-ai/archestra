import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import { TokenResponse } from '@backend/config/oauth-provider-interface';
import { getOAuthProvider } from '@backend/config/oauth-providers';
import {
  McpServerConfigSchema,
  McpServerSchema,
  McpServerUserConfigValuesSchema,
} from '@backend/database/schema/mcpServer';
import McpRequestLog from '@backend/models/mcpRequestLog';
import McpServerModel, { McpServerInstallSchema } from '@backend/models/mcpServer';
import McpServerSandboxManager from '@backend/sandbox/manager';
import { AvailableToolSchema, McpServerContainerLogsSchema } from '@backend/sandbox/sandboxedMcp';
import { ErrorResponseSchema } from '@backend/schemas';
import log from '@backend/utils/logger';
import { OAUTH_REQUEST_CONFIG, OAUTH_STATE_CLEANUP, getOAuthProxyUrl } from '@backend/utils/oauth-config';
import { getAuthorizationParams, handleProviderTokens, validateProvider } from '@backend/utils/oauth-provider-helper';
import { generateCodeChallenge, generateCodeVerifier, generateState } from '@backend/utils/pkce';

// Store for pending OAuth installations with PKCE data
interface PendingOAuthInstall {
  installData: z.infer<typeof McpServerInstallSchema>;
  codeVerifier: string;
  redirectUri: string;
  timestamp: number;
}
const pendingOAuthInstalls = new Map<string, PendingOAuthInstall>();

/**
 * Helper function to extract email from Google ID token
 * ID tokens are JWT tokens with payload containing user info
 */
function extractEmailFromIdToken(idToken: string): string | undefined {
  try {
    // ID token is a JWT: header.payload.signature
    const parts = idToken.split('.');
    if (parts.length !== 3) return undefined;
    
    // Decode the payload (base64url encoded)
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const data = JSON.parse(payload);
    
    return data.email;
  } catch (error) {
    log.error('Failed to extract email from ID token:', error);
    return undefined;
  }
}

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

  fastify.post(
    '/api/mcp_server/start_oauth',
    {
      schema: {
        operationId: 'startMcpServerOauth',
        description: 'Start MCP server OAuth flow',
        tags: ['MCP Server'],
        body: z.object({
          catalogName: z.string(),
          installData: McpServerInstallSchema,
        }),
        response: {
          200: z.object({ authUrl: z.string(), state: z.string() }),
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body: { catalogName, installData } }, reply) => {
      try {
        // Get OAuth provider configuration
        const providerName = installData.oauthProvider || 'google';
        const provider = getOAuthProvider(providerName);

        // Validate provider configuration
        validateProvider(provider);

        // Generate PKCE parameters
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        // Determine redirect URI based on environment and provider
        // OAuth provider redirects to proxy, which then uses deeplink to open desktop app
        const redirectUri = process.env.OAUTH_REDIRECT_URI || `${getOAuthProxyUrl()}/callback/${providerName}`;

        // Store pending installation with PKCE verifier
        pendingOAuthInstalls.set(state, {
          installData,
          codeVerifier,
          redirectUri,
          timestamp: Date.now(),
        });

        // Clean up old pending installs (older than 10 minutes)
        const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
        for (const [key, data] of pendingOAuthInstalls.entries()) {
          if (data.timestamp < tenMinutesAgo && key !== state) {
            pendingOAuthInstalls.delete(key);
          }
        }

        // Build OAuth authorization URL with PKCE
        const baseParams: Record<string, string> = {
          client_id: provider.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: provider.scopes.join(' '),
          state: state,
          access_type: 'offline', // For Google refresh tokens
          prompt: 'consent', // Force consent to get refresh token
        };

        // Add PKCE parameters if provider supports it
        if (provider.usePKCE) {
          baseParams.code_challenge = codeChallenge;
          baseParams.code_challenge_method = 'S256';
        }

        // Get provider-specific authorization parameters
        const authParams = getAuthorizationParams(provider, baseParams);
        const params = new URLSearchParams(authParams);

        const authUrl = `${provider.authorizationUrl}?${params.toString()}`;
        fastify.log.info(`OAuth URL for ${catalogName} with provider ${providerName}: ${authUrl}`);

        return reply.send({ authUrl, state });
      } catch (error) {
        fastify.log.error('Error starting OAuth flow:', error);
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to start OAuth flow',
        });
      }
    }
  );

  // OAuth callback endpoint for handling redirects from providers
  fastify.get(
    '/api/oauth/callback',
    {
      schema: {
        operationId: 'oauthCallback',
        description: 'OAuth callback endpoint for provider redirects',
        tags: ['MCP Server'],
        querystring: z.object({
          code: z.string(),
          state: z.string(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async ({ query }, reply) => {
      const { code, state, error, error_description } = query;

      if (error) {
        // Redirect to frontend with error
        return reply.redirect(`/oauth-callback?error=${encodeURIComponent(error_description || error)}`);
      }

      // Redirect to frontend with code and state
      return reply.redirect(`/oauth-callback?code=${code}&state=${state}`);
    }
  );

  fastify.post(
    '/api/mcp_server/complete_oauth',
    {
      schema: {
        operationId: 'completeMcpServerOauth',
        description: 'Complete MCP server OAuth flow and install with tokens',
        tags: ['MCP Server'],
        body: z.object({
          service: z.string(),
          state: z.string(),
          // Either provide tokens directly (old flow) or code for exchange (new flow)
          access_token: z.string().optional(),
          refresh_token: z.string().optional(),
          expiry_date: z.string().optional(),
          code: z.string().optional(),
        }),
        response: {
          200: McpServerSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body }, reply) => {
      const { service, access_token, refresh_token, expiry_date, state } = body;

      // For new PKCE flow, we need to exchange the code
      if (body.code && !access_token) {
        // Retrieve pending installation data using state
        const pendingInstall = pendingOAuthInstalls.get(state);

        if (!pendingInstall) {
          return reply.code(400).send({ error: 'Invalid or expired OAuth state' });
        }

        try {
          // Call the OAuth proxy to exchange code for tokens
          const providerName = service || pendingInstall.installData.oauthProvider || 'google';
          const oauthProxyUrl = getOAuthProxyUrl();

          // For development with self-signed certificates, we need special handling
          let tokenResponse;
          try {
            const tokenUrl = `${oauthProxyUrl}/oauth/token`;
            fastify.log.info(`Exchanging OAuth token at: ${tokenUrl}`);
            fastify.log.info(`NODE_ENV: ${process.env.NODE_ENV}`);
            fastify.log.info(`OAuth Proxy URL: ${oauthProxyUrl}`);

            // In development, handle self-signed certificates
            // Check for localhost URLs regardless of NODE_ENV since we're clearly in local development
            if (oauthProxyUrl.includes('localhost')) {
              fastify.log.info('Disabling certificate validation for localhost');
              // Temporarily disable certificate validation for local development
              process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
            }

            tokenResponse = await fetch(tokenUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                grant_type: 'authorization_code',
                provider: service || pendingInstall.installData.oauthProvider || 'google',
                code: body.code,
                code_verifier: pendingInstall.codeVerifier,
                redirect_uri: pendingInstall.redirectUri,
              }),
            });

            // Re-enable certificate validation
            if (oauthProxyUrl.includes('localhost')) {
              delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
            }
          } catch (fetchError) {
            fastify.log.error('Fetch error details:', fetchError);
            fastify.log.error('Fetch error stack:', fetchError.stack);
            // Re-enable certificate validation in case of error
            delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
            throw new Error(`Failed to connect to OAuth proxy at ${oauthProxyUrl}: ${fetchError.message}`);
          }

          if (!tokenResponse.ok) {
            const error = await tokenResponse.json();
            throw new Error(error.error_description || error.error || 'Token exchange failed');
          }

          const tokens = await tokenResponse.json();

          // Continue with the installation using the tokens
          body.access_token = tokens.access_token;
          body.refresh_token = tokens.refresh_token;
          body.expiry_date = tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : undefined;
        } catch (error) {
          fastify.log.error('Token exchange error:', error);
          return reply.code(400).send({
            error: error instanceof Error ? error.message : 'Token exchange failed',
          });
        }
      }

      // Retrieve pending installation data using state
      const pendingInstall = pendingOAuthInstalls.get(state);

      if (!pendingInstall) {
        return reply.code(400).send({ error: 'Invalid or expired OAuth state' });
      }

      // Remove from pending
      pendingOAuthInstalls.delete(state);

      try {
        const { installData } = pendingInstall;
        const providerName = service || installData.oauthProvider || 'google';
        const provider = getOAuthProvider(providerName);

        // Handle tokens using the provider's configuration
        const tokens: TokenResponse = {
          access_token: body.access_token!,
          refresh_token: body.refresh_token,
          expires_in: body.expiry_date
            ? Math.floor((new Date(body.expiry_date).getTime() - Date.now()) / 1000)
            : undefined,
        };

        const tokenEnvVars = await handleProviderTokens(provider, tokens, installData.id || installData.displayName);

        // For Google provider, extract email from user config values
        let googleEmail: string | undefined;
        if (providerName === 'google' && installData.userConfigValues) {
          // Try to find email from user config values
          // Common field names: email, user_email, account_email, google_email
          const emailValue = installData.userConfigValues.email || 
                            installData.userConfigValues.user_email || 
                            installData.userConfigValues.account_email ||
                            installData.userConfigValues.google_email;
          
          // Convert to string if it's a valid value
          if (typeof emailValue === 'string') {
            googleEmail = emailValue;
          } else if (emailValue) {
            googleEmail = String(emailValue);
          } else {
            // If no email in config, try to decode from ID token if available
            googleEmail = (tokens.id_token ? extractEmailFromIdToken(tokens.id_token) : undefined) ||
                         // Fallback to a default
                         'user@example.com';
          }
        }

        // If provider has custom handler, tokenEnvVars will be undefined
        // Otherwise, add the env vars to the server config
        const updatedConfig = tokenEnvVars
          ? {
              ...installData.serverConfig,
              env: {
                ...installData.serverConfig.env,
                ...tokenEnvVars,
                // Add Google email if available
                ...(googleEmail ? { GOOGLE_OAUTH_EMAIL: googleEmail } : {}),
              },
            }
          : installData.serverConfig;

        // Install MCP server with tokens in server_config and OAuth fields
        const server = await McpServerModel.installMcpServer({
          ...installData,
          serverConfig: updatedConfig,
          oauthAccessToken: body.access_token,
          oauthRefreshToken: body.refresh_token,
          oauthExpiryDate: body.expiry_date || null,
        });

        fastify.log.info(`MCP server ${installData.id} installed with OAuth tokens`);

        return reply.code(200).send(server);
      } catch (error: any) {
        log.error('Failed to install MCP server with OAuth:', error);

        if (error.message?.includes('already installed')) {
          return reply.code(400).send({ error: error.message });
        }

        return reply.code(500).send({ error: 'Failed to complete OAuth installation' });
      }
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

        // Stream the request to the container!
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
      return reply.send(McpServerSandboxManager.allAvailableTools);
    }
  );
};

export default mcpServerRoutes;
