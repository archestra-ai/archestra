/**
 * Generic OAuth 2.0 Flow Implementation
 *
 * For OAuth providers that don't support MCP SDK requirements (like Slack)
 * Implements standard OAuth 2.0 Authorization Code flow with PKCE
 * Uses deep link callback mechanism same as MCP OAuth
 */
import { spawn } from 'child_process';
import * as crypto from 'crypto';

import OAuthProxyClient from '@backend/clients/oauthProxy';
import McpServerModel from '@backend/models/mcpServer';
import { type OAuthServerConfig } from '@backend/schemas/oauth-config';
import log from '@backend/utils/logger';

// Import authorization code storage from MCP OAuth provider
import { authCodeStore } from '../mcp-oauth/provider';

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
 * Wait for authorization code to be received via deep link when using OAuth proxy
 */
async function waitForAuthorizationCode(state: string): Promise<string> {
  const maxWaitTime = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 500; // 500ms
  const startTime = Date.now();

  log.info(`🔍 Waiting for authorization code for state: ${state.substring(0, 10)}...`);
  log.info(`📊 Current authCodeStore size: ${authCodeStore.size}`);
  log.info(
    `🗂️ AuthCodeStore keys: ${Array.from(authCodeStore.keys())
      .map((k) => k.substring(0, 10) + '...')
      .join(', ')}`
  );

  while (Date.now() - startTime < maxWaitTime) {
    const code = authCodeStore.get(state);
    if (code) {
      log.info(`✅ Authorization code found for state: ${state.substring(0, 10)}...`);
      // Clean up stored code
      authCodeStore.delete(state);
      return code;
    }

    // Log progress every 5 seconds
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > 0 && elapsed % 5 === 0) {
      log.info(`⏳ Still waiting for authorization code... (${elapsed}s elapsed)`);
      log.info(`📊 Current authCodeStore size: ${authCodeStore.size}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  log.error(`⏰ Timeout waiting for authorization code for state: ${state.substring(0, 10)}...`);
  log.error(`📊 Final authCodeStore size: ${authCodeStore.size}`);
  log.error(
    `🗂️ Final AuthCodeStore keys: ${Array.from(authCodeStore.keys())
      .map((k) => k.substring(0, 10) + '...')
      .join(', ')}`
  );
  throw new Error('Timeout waiting for authorization code from OAuth proxy');
}

/**
 * Store OAuth tokens in database and optionally inject access token into environment variable and files
 */
async function storeTokensWithEnvVar(
  serverId: string,
  tokens: GenericOAuthTokens,
  config: OAuthServerConfig
): Promise<void> {
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
    // Start with the current mcp_config as the base for database storage
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
 * Exchange authorization code for tokens (simple OAuth 2.0)
 */
async function exchangeCodeForTokens(
  config: OAuthServerConfig,
  code: string,
  serverId?: string
): Promise<GenericOAuthTokens> {
  const tokenEndpoint = config.token_endpoint || config.server_url.replace('/authorize', '/access');

  // Check if this provider requires oauth-proxy
  if (config.requires_proxy && serverId) {
    log.info(`Using oauth-proxy for token exchange for ${config.name}`);
    return OAuthProxyClient.exchangeGenericOAuthTokens(serverId, tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirect_uris[0],
    });
  }

  // Direct request for providers that don't require proxy (e.g. DCR providers)
  log.info(`Using direct token exchange for ${config.name}`);

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
 * Start generic OAuth flow with OAuth proxy callback
 */
export async function startGenericOAuthFlow(config: OAuthServerConfig, serverId: string): Promise<string> {
  log.info(`🔐 Starting generic OAuth flow for ${config.name}`);

  const state = generateState();

  // Store state for verification
  storeOAuthState(serverId, state);

  const authUrl = buildAuthorizationUrl(config, state);

  log.info(`📋 Authorization URL: ${authUrl}`);

  // Open the authorization URL in the default browser
  // OAuth proxy will handle callback via deep link
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

  log.info('📡 Using OAuth proxy - will wait for deep link callback');

  // Wait for authorization code to be stored via deep link callback
  let authorizationCode: string;
  try {
    authorizationCode = await waitForAuthorizationCode(state);
    log.info('✅ Authorization code received via deep link callback');
  } catch (error) {
    // OAuth flow timed out or failed - clean up the server record
    log.warn(`OAuth flow timed out for server ${serverId}, cleaning up...`);

    try {
      await McpServerModel.update(serverId, {
        status: 'failed',
        oauthClientInfo: null,
      });
    } catch (cleanupError) {
      log.error('Failed to cleanup server after OAuth timeout:', cleanupError);
    }

    throw error;
  }

  // Exchange authorization code for tokens
  log.info('🔄 Exchanging authorization code for tokens...');
  const tokens = await exchangeCodeForTokens(config, authorizationCode, serverId);

  // Store tokens in database with environment variable injection
  await storeTokensWithEnvVar(serverId, tokens, config);

  // Update server status to installed and start the server
  const [updatedServer] = await McpServerModel.update(serverId, {
    status: 'installed',
    oauthClientInfo: null, // Clear the temporary config storage
  });

  // Start the MCP server if it's a local server
  if (updatedServer.serverType === 'local') {
    try {
      await McpServerModel.startServerAndSyncAllConnectedExternalMcpClients(updatedServer);
      log.info(`✅ Generic OAuth MCP server ${updatedServer.name} started successfully after OAuth completion`);
    } catch (startupError) {
      log.error(
        `❌ Failed to start generic OAuth MCP server ${updatedServer.name} after OAuth completion:`,
        startupError
      );

      // Rollback server status to 'failed' if startup fails
      await McpServerModel.update(serverId, {
        status: 'failed',
      });

      throw new Error(
        `OAuth completed successfully but server startup failed: ${startupError instanceof Error ? startupError.message : 'Unknown startup error'}`
      );
    }
  }

  log.info('✅ Generic OAuth flow completed successfully');
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
  const tokens = await exchangeCodeForTokens(config, code, serverId);

  // Store tokens and optionally inject into environment variables
  await storeTokensWithEnvVar(serverId, tokens, config);

  // Update server status to installed and start the server
  const [updatedServer] = await McpServerModel.update(serverId, {
    status: 'installed',
    oauthClientInfo: null, // Clear the temporary config storage
  });

  // Start the MCP server if it's a local server
  if (updatedServer.serverType === 'local') {
    try {
      await McpServerModel.startServerAndSyncAllConnectedExternalMcpClients(updatedServer);
      log.info(`✅ Generic OAuth MCP server ${updatedServer.name} started successfully after OAuth completion`);
    } catch (startupError) {
      log.error(
        `❌ Failed to start generic OAuth MCP server ${updatedServer.name} after OAuth completion:`,
        startupError
      );

      // Rollback server status to 'failed' if startup fails
      await McpServerModel.update(serverId, {
        status: 'failed',
      });

      throw new Error(
        `OAuth completed successfully but server startup failed: ${startupError instanceof Error ? startupError.message : 'Unknown startup error'}`
      );
    }
  }

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
