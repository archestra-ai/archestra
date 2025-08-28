import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { McpServerSchema } from '@backend/database/schema/mcpServer';
import McpServerModel, { McpServerInstallSchema } from '@backend/models/mcpServer';
import { ErrorResponseSchema } from '@backend/schemas';
import log from '@backend/utils/logger';

import { TokenResponse } from './provider-interface';
import { getOAuthProvider } from './providers';
import { getOAuthProxyUrl } from './utils/oauth-config';
import { getAuthorizationParams, handleProviderTokens, validateProvider } from './utils/oauth-provider-helper';
import { generateCodeChallenge, generateCodeVerifier, generateState } from './utils/pkce';

// Store for pending OAuth installations with PKCE data
interface PendingOAuthInstall {
  installData: z.infer<typeof McpServerInstallSchema>;
  codeVerifier: string;
  redirectUri: string;
  timestamp: number;
}
const pendingOAuthInstalls = new Map<string, PendingOAuthInstall>();

const oauthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    '/api/mcp_server/start_oauth',
    {
      schema: {
        operationId: 'startMcpServerOauth',
        description: 'Start MCP server OAuth flow',
        tags: ['MCP Server', 'OAuth'],
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
        tags: ['OAuth'],
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
        tags: ['MCP Server', 'OAuth'],
        body: z.object({
          service: z.string(),
          state: z.string(),
          // Either provide tokens directly (old flow) or code for exchange (new flow)
          access_token: z.string().optional(),
          refresh_token: z.string().optional(),
          expiry_date: z.string().optional(),
          code: z.string().optional(),
          id_token: z.string().optional(), // Google OAuth provides ID token with user info
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

          // Exchange code for tokens via OAuth proxy
          const tokenUrl = `${oauthProxyUrl}/oauth/token`;
          fastify.log.info(`Exchanging OAuth token at: ${tokenUrl}`);

          const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              provider: service || pendingInstall.installData.oauthProvider || 'google',
              code: body.code,
              code_verifier: pendingInstall.codeVerifier,
              redirect_uri: pendingInstall.redirectUri,
            }),
          }).catch((fetchError) => {
            fastify.log.error('Fetch error details:', fetchError);
            fastify.log.error('Fetch error stack:', fetchError.stack);
            throw new Error(`Failed to connect to OAuth proxy at ${oauthProxyUrl}: ${fetchError.message}`);
          });

          if (!tokenResponse.ok) {
            const error = await tokenResponse.json();
            throw new Error(error.error_description || error.error || 'Token exchange failed');
          }

          const tokens = await tokenResponse.json();

          // Log the full response from OAuth proxy for debugging
          fastify.log.info({ tokens }, 'OAuth proxy token response');

          // Continue with the installation using the tokens
          body.access_token = tokens.access_token;
          body.refresh_token = tokens.refresh_token;
          body.expiry_date = tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : undefined;
          // Store ID token for email extraction (Google OAuth)
          if (tokens.id_token) {
            body.id_token = tokens.id_token;
            fastify.log.info('ID token found in OAuth response');
          } else {
            fastify.log.warn('No ID token in OAuth response');
          }
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
          id_token: body.id_token,
        };

        const tokenEnvVars = await handleProviderTokens(provider, tokens, installData.id || installData.displayName);

        // Log the complete body for debugging
        fastify.log.info({ body }, 'Complete body object');
        fastify.log.info({ tokens }, 'TokenResponse object');

        // Extract user email if provider supports it
        let userEmail: string | undefined;
        if (provider.extractUserEmail) {
          fastify.log.info(`Provider ${providerName} supports email extraction`);
          userEmail = await provider.extractUserEmail(tokens);

          if (!userEmail) {
            fastify.log.warn(`Could not extract email from ${providerName} OAuth, using fallback`);
            // Provider-specific fallback (for Google, this is required)
            if (providerName === 'google') {
              userEmail = 'user@example.com';
            }
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
                // Add provider-specific email if available
                ...(providerName === 'google' && userEmail ? { GOOGLE_OAUTH_EMAIL: userEmail } : {}),
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
};

export default oauthRoutes;
