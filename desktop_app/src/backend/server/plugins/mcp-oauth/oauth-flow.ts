/**
 * OAuth Flow Implementation using MCP SDK
 *
 * Based on performOAuth from linear-mcp-oauth-minimal.ts
 * Handles OAuth authentication flow using @modelcontextprotocol/sdk/client/auth.js
 */
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import { type OAuthServerConfig } from '@backend/schemas/oauth-config';
import log from '@backend/utils/logger';

import { McpOAuthProvider } from './provider';

/**
 * Handle OAuth authentication flow using MCP SDK
 */
export async function performOAuth(provider: McpOAuthProvider, config: OAuthServerConfig): Promise<string> {
  log.info('🔐 Starting OAuth with MCP SDK...');

  // First attempt: try with existing tokens
  let authResult = await auth(provider, {
    serverUrl: config.server_url,
    scope: config.scopes.join(' '),
    resourceMetadataUrl: config.resource_metadata_url ? new URL(config.resource_metadata_url) : undefined,
  });

  log.info('✅ OAuth result (initial):', authResult);

  // If we need to redirect, handle the OAuth flow with authorization code
  if (authResult === 'REDIRECT') {
    log.info('🔄 OAuth requires authorization - authorization code will be captured automatically');

    // Wait a moment for the browser flow to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Now try with the captured authorization code
    if (provider.authorizationCode) {
      log.info('🔐 Using captured authorization code for token exchange...');
      authResult = await auth(provider, {
        serverUrl: config.server_url,
        scope: config.scopes.join(' '),
        authorizationCode: provider.authorizationCode,
        resourceMetadataUrl: config.resource_metadata_url ? new URL(config.resource_metadata_url) : undefined,
      });

      log.info('✅ OAuth result (with code):', authResult);
    } else {
      throw new Error('No authorization code captured');
    }
  }

  if (authResult !== 'AUTHORIZED') {
    throw new Error(`OAuth not authorized: ${authResult}`);
  }

  // Get the actual access token from the provider after successful auth
  const tokens = await provider.tokens();
  if (!tokens || !tokens.access_token) {
    throw new Error('No access token found after OAuth');
  }

  log.info('✅ OAuth completed! Token:', tokens.access_token.substring(0, 30) + '...');
  return tokens.access_token;
}

/**
 * Refresh OAuth tokens using MCP SDK
 */
export async function refreshOAuthTokens(
  provider: McpOAuthProvider,
  config: OAuthServerConfig
): Promise<OAuthTokens | null> {
  log.info('🔄 Refreshing OAuth tokens...');

  try {
    const currentTokens = await provider.tokens();
    if (!currentTokens?.refresh_token) {
      log.warn('⚠️  No refresh token available, cannot refresh');
      return null;
    }

    // Use MCP SDK auth with refresh flow
    // Note: MCP SDK auth doesn't directly support refreshToken parameter
    // We need to handle token refresh through the provider's refresh mechanism
    const authResult = await auth(provider, {
      serverUrl: config.server_url,
      scope: config.scopes.join(' '),
      resourceMetadataUrl: config.resource_metadata_url ? new URL(config.resource_metadata_url) : undefined,
    });

    if (authResult === 'AUTHORIZED') {
      const refreshedTokens = await provider.tokens();
      if (refreshedTokens) {
        log.info('✅ Tokens refreshed successfully');
        return refreshedTokens;
      }
    }

    log.warn('⚠️  Token refresh failed:', authResult);
    return null;
  } catch (error) {
    log.error('❌ Token refresh error:', error);
    return null;
  }
}

/**
 * Check if OAuth tokens are expired or will expire soon
 */
export function areTokensExpired(tokens: OAuthTokens, bufferMinutes: number = 5): boolean {
  if (!tokens.expires_in) {
    return false; // No expiry info, assume valid
  }

  // Calculate expiry time (expires_in is in seconds)
  const expiryTime = Date.now() + tokens.expires_in * 1000;
  const bufferTime = bufferMinutes * 60 * 1000; // Convert minutes to milliseconds

  return expiryTime - bufferTime <= Date.now();
}

/**
 * Ensure valid OAuth tokens, refreshing if necessary
 */
export async function ensureValidTokens(provider: McpOAuthProvider, config: OAuthServerConfig): Promise<string> {
  const tokens = await provider.tokens();

  if (!tokens || !tokens.access_token) {
    throw new Error('No OAuth tokens available');
  }

  // Check if tokens are expired or will expire soon
  if (areTokensExpired(tokens)) {
    log.info('🔄 Tokens expired or expiring soon, attempting refresh...');

    const refreshedTokens = await refreshOAuthTokens(provider, config);
    if (refreshedTokens && refreshedTokens.access_token) {
      return refreshedTokens.access_token;
    } else {
      throw new Error('Failed to refresh expired tokens');
    }
  }

  return tokens.access_token;
}
