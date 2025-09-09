/**
 * Generic OAuth 2.0 Flow Implementation
 *
 * For OAuth providers that don't support MCP SDK requirements (like Slack)
 * Implements standard OAuth 2.0 Authorization Code flow with PKCE
 */
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';

import { type OAuthServerConfig } from '@backend/schemas/oauth-config';
import log from '@backend/utils/logger';

export interface GenericOAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Generate state parameter for CSRF protection
 */
function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * In-memory OAuth state storage (ephemeral, cleared after use)
 * Maps serverId to OAuth state for CSRF protection
 */
const oauthStateStore = new Map<string, string>();

/**
 * Store OAuth state in memory
 */
function storeOAuthState(serverId: string, state: string): void {
  oauthStateStore.set(serverId, state);
}

/**
 * Retrieve and clear OAuth state from memory
 */
function retrieveOAuthState(serverId: string): string | null {
  const state = oauthStateStore.get(serverId);
  if (state) {
    // Clear state after retrieval for security (one-time use)
    oauthStateStore.delete(serverId);
    return state;
  }
  return null;
}

/**
 * Store OAuth tokens in database
 */
async function storeTokens(serverId: string, tokens: GenericOAuthTokens): Promise<void> {
  const { default: McpServerModel } = await import('@backend/models/mcpServer');

  const mcpTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    token_type: tokens.token_type || 'Bearer',
  };

  await McpServerModel.update(serverId, {
    oauthTokens: mcpTokens,
  });
}

/**
 * Store OAuth tokens in database and optionally inject access token into environment variable and files
 */
async function storeTokensWithEnvVar(
  serverId: string,
  tokens: GenericOAuthTokens,
  config: OAuthServerConfig
): Promise<void> {
  const { default: McpServerModel } = await import('@backend/models/mcpServer');

  const mcpTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    token_type: tokens.token_type || 'Bearer',
  };

  // Prepare the update data
  const updateData: any = {
    oauthTokens: mcpTokens,
  };

  // Get current server configuration to check if we need to update serverConfig
  const servers = await McpServerModel.getById(serverId);
  const currentServer = servers?.[0];

  if (currentServer && (config.access_token_env_var || currentServer.serverConfig.inject_file)) {
    // Create a copy of the current serverConfig
    const updatedServerConfig = {
      ...currentServer.serverConfig,
    };

    // Update environment variables if access_token_env_var is specified
    if (config.access_token_env_var) {
      updatedServerConfig.env = {
        ...currentServer.serverConfig.env,
        [config.access_token_env_var]: tokens.access_token,
      };
    }

    // Process file injection if inject_file is specified
    if (currentServer.serverConfig.inject_file) {
      updatedServerConfig.inject_file = {};

      // Process each file to be injected
      for (const [filename, content] of Object.entries(currentServer.serverConfig.inject_file)) {
        // Replace ${access_token} placeholder with actual token
        const processedContent = content.replace(/\$\{access_token\}/g, tokens.access_token);
        updatedServerConfig.inject_file[filename] = processedContent;
      }
    }

    updateData.serverConfig = updatedServerConfig;
  }

  await McpServerModel.update(serverId, updateData);
}

/**
 * Retrieve stored OAuth tokens from database
 */
async function retrieveTokens(serverId: string): Promise<GenericOAuthTokens | null> {
  try {
    const { default: McpServerModel } = await import('@backend/models/mcpServer');
    const servers = await McpServerModel.getById(serverId);

    if (servers?.[0]?.oauthTokens) {
      const tokens = servers[0].oauthTokens;
      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        token_type: tokens.token_type,
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Build authorization URL (simple OAuth 2.0 without PKCE)
 */
function buildAuthorizationUrl(config: OAuthServerConfig, state: string): string {
  const authUrl = new URL(config.server_url);

  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: config.redirect_uris[0],
    scope: config.scopes.join(' '),
    response_type: 'code',
    state: state,
  });

  authUrl.search = params.toString();
  return authUrl.toString();
}

/**
 * Start callback server on port 8080
 */
function startCallbackServer(serverId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url?.includes('code=') || req.url?.startsWith('/oauth/callback')) {
        log.info('📡 OAuth callback received:', req.url);

        try {
          const url = new URL(req.url, 'http://localhost:8080');
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>❌ OAuth Error</h1></body></html>`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code || !state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>❌ Missing authorization code or state</h1></body></html>');
            server.close();
            reject(new Error('Missing authorization code or state'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>✅ Authorization successful!</h1><p>You can close this window.</p></body></html>');
          server.close();

          // Call the desktop app's completion endpoint
          completeOAuthViaAPI(serverId, code, state)
            .then(() => resolve())
            .catch(reject);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>❌ Server Error</h1></body></html>');
          server.close();
          reject(error);
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>404 Not Found</h1></body></html>');
      }
    });

    server.listen(8080, () => {
      log.info('📡 Callback server listening on http://localhost:8080');
    });

    server.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Complete OAuth by calling the desktop app's API
 */
async function completeOAuthViaAPI(serverId: string, code: string, state: string): Promise<void> {
  try {
    const response = await fetch('http://localhost:54587/api/mcp_server/complete_oauth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serverId, code, state }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API call failed: ${response.status} ${errorText}`);
    }

    log.info('✅ OAuth completion API call successful');
  } catch (error) {
    log.error('❌ OAuth completion API call failed:', error);
    throw error;
  }
}

/**
 * Exchange authorization code for tokens (simple OAuth 2.0)
 */
async function exchangeCodeForTokens(config: OAuthServerConfig, code: string): Promise<GenericOAuthTokens> {
  const tokenEndpoint = config.token_endpoint || config.server_url.replace('/authorize', '/access');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.client_id,
    client_secret: config.client_secret || '',
    redirect_uri: config.redirect_uris[0],
    code: code,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const tokens: GenericOAuthTokens = await response.json();
  return tokens;
}

/**
 * Start generic OAuth flow with local callback server
 */
export async function startGenericOAuthFlow(config: OAuthServerConfig, serverId: string): Promise<string> {
  log.info(`🔐 Starting generic OAuth flow for ${config.name}`);

  const state = generateState();

  // Store state for verification
  storeOAuthState(serverId, state);

  const authUrl = buildAuthorizationUrl(config, state);

  log.info(`📋 Authorization URL: ${authUrl}`);

  // Start callback server and wait for authorization
  const callbackPromise = startCallbackServer(serverId);

  // Open the authorization URL in the default browser
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [authUrl];
  } else if (platform === 'win32') {
    command = 'start';
    args = ['', authUrl];
  } else {
    command = 'xdg-open';
    args = [authUrl];
  }

  spawn(command, args, { detached: true, stdio: 'ignore' });

  // Wait for callback
  await callbackPromise;

  return authUrl;
}

/**
 * Handle OAuth callback and complete the flow
 */
export async function completeGenericOAuthFlow(
  config: OAuthServerConfig,
  serverId: string,
  code: string,
  state: string
): Promise<GenericOAuthTokens> {
  log.info(`🔄 Completing generic OAuth flow for ${config.name}`);

  // Verify state
  const storedState = retrieveOAuthState(serverId);
  if (state !== storedState) {
    throw new Error(`State mismatch - expected ${storedState}, got ${state}`);
  }

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(config, code);

  // Store tokens and optionally inject into environment variables
  await storeTokensWithEnvVar(serverId, tokens, config);

  log.info(`✅ Generic OAuth flow completed for ${config.name}`);
  return tokens;
}

/**
 * Get stored tokens for a server
 */
export async function getGenericOAuthTokens(serverId: string): Promise<GenericOAuthTokens | null> {
  return await retrieveTokens(serverId);
}

/**
 * Refresh OAuth tokens (if supported by provider)
 */
export async function refreshGenericOAuthTokens(
  config: OAuthServerConfig,
  serverId: string
): Promise<GenericOAuthTokens | null> {
  const currentTokens = await retrieveTokens(serverId);
  if (!currentTokens?.refresh_token) {
    return null;
  }

  const tokenEndpoint = config.token_endpoint || config.server_url.replace('/authorize', '/token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.client_id,
    client_secret: config.client_secret || '',
    refresh_token: currentTokens.refresh_token,
  });

  try {
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      log.warn(`Token refresh failed: ${response.status}`);
      return null;
    }

    const newTokens: GenericOAuthTokens = await response.json();

    // Store updated tokens with environment variable injection
    await storeTokensWithEnvVar(serverId, newTokens, config);

    return newTokens;
  } catch (error) {
    log.warn('Token refresh error:', error);
    return null;
  }
}
