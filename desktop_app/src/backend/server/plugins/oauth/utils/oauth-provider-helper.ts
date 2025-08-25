/**
 * OAuth Provider Helper Utilities
 *
 * This module provides helper functions for handling OAuth providers
 * in a unified way, supporting both standard and custom token handlers.
 */
import log from '@backend/utils/logger';

import { BrowserTokenResponse, OAuthProviderDefinition, TokenResponse } from '../provider-interface';

/**
 * Handle OAuth tokens for a provider.
 * Routes to either custom handler or default environment variable approach.
 *
 * @param provider - The OAuth provider definition
 * @param tokens - The OAuth tokens to store
 * @param serverId - The MCP server ID
 * @returns The environment variables to add to server config (if using default approach)
 */
export async function handleProviderTokens(
  provider: OAuthProviderDefinition,
  tokens: TokenResponse,
  serverId: string
): Promise<Record<string, string> | void> {
  log.info(`[OAuth Helper] Handling tokens for provider: ${provider.name}`);

  // If provider has a custom token handler, use it
  if (provider.tokenHandler) {
    log.info(`[OAuth Helper] Using custom token handler for ${provider.name}`);
    await provider.tokenHandler(tokens, serverId);
    return; // Custom handler manages everything
  }

  // Otherwise, use the default environment variable pattern
  if (provider.tokenEnvVarPattern) {
    log.info(`[OAuth Helper] Using environment variable pattern for ${provider.name}`);
    const envVars: Record<string, string> = {};

    // Add access token
    if (tokens.access_token && provider.tokenEnvVarPattern.accessToken) {
      envVars[provider.tokenEnvVarPattern.accessToken] = tokens.access_token;
    }

    // Add refresh token if present
    if (tokens.refresh_token && provider.tokenEnvVarPattern.refreshToken) {
      envVars[provider.tokenEnvVarPattern.refreshToken] = tokens.refresh_token;
    }

    // Add expiry date if present
    if (tokens.expires_in && provider.tokenEnvVarPattern.expiryDate) {
      const expiryDate = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      envVars[provider.tokenEnvVarPattern.expiryDate] = expiryDate;
    }

    return envVars;
  }

  // No handler configured - this shouldn't happen if provider is properly configured
  throw new Error(`No token handler configured for provider: ${provider.name}`);
}

/**
 * Get authorization URL parameters for a provider.
 * Combines standard OAuth parameters with provider-specific ones.
 *
 * @param provider - The OAuth provider definition
 * @param baseParams - Standard OAuth parameters (client_id, redirect_uri, etc.)
 * @returns Combined parameters for the authorization URL
 */
export function getAuthorizationParams(
  provider: OAuthProviderDefinition,
  baseParams: Record<string, string>
): Record<string, string> {
  const params = { ...baseParams };

  // Add provider-specific authorization parameters
  if (provider.authorizationParams) {
    Object.assign(params, provider.authorizationParams);
  }

  // Special case for Slack: add user_scope if it's in the params
  if (provider.name === 'slack' && provider.authorizationParams?.user_scope) {
    params.user_scope = provider.authorizationParams.user_scope;
  }

  return params;
}

/**
 * Check if a provider requires special authentication flow.
 * Some providers (like Slack) support browser-based authentication.
 *
 * @param provider - The OAuth provider definition
 * @returns Whether special authentication is required
 */
export function requiresSpecialAuth(provider: OAuthProviderDefinition): boolean {
  return provider.requiresSpecialAuth || false;
}

/**
 * Get the appropriate redirect URI for a provider.
 * Some providers may need special redirect handling.
 *
 * @param provider - The OAuth provider definition
 * @param defaultRedirectUri - The default redirect URI
 * @returns The redirect URI to use
 */
export function getRedirectUri(provider: OAuthProviderDefinition, defaultRedirectUri: string): string {
  // Most providers use the default redirect URI
  // Add provider-specific overrides here if needed
  return defaultRedirectUri;
}

/**
 * Validate that a provider is properly configured.
 * Ensures either tokenHandler or tokenEnvVarPattern is defined.
 *
 * @param provider - The OAuth provider definition to validate
 * @throws Error if provider is not properly configured
 */
export function validateProvider(provider: OAuthProviderDefinition): void {
  if (!provider.name) {
    throw new Error('Provider must have a name');
  }

  // Browser auth providers have different requirements
  if (provider.browserAuthConfig?.enabled) {
    if (!provider.browserAuthConfig.loginUrl) {
      throw new Error(`Browser auth provider ${provider.name} must have a login URL`);
    }
    if (!provider.browserAuthConfig.extractTokens) {
      throw new Error(`Browser auth provider ${provider.name} must have token extraction function`);
    }
  } else {
    // Standard OAuth providers need authorization URL and scopes
    if (!provider.authorizationUrl) {
      throw new Error(`Provider ${provider.name} must have an authorization URL`);
    }

    if (!provider.scopes || provider.scopes.length === 0) {
      throw new Error(`Provider ${provider.name} must have at least one scope`);
    }
  }

  if (!provider.clientId) {
    throw new Error(`Provider ${provider.name} must have a client ID`);
  }

  // Must have either custom handler or env var pattern
  if (!provider.tokenHandler && !provider.tokenEnvVarPattern) {
    throw new Error(`Provider ${provider.name} must have either tokenHandler or tokenEnvVarPattern configured`);
  }

  // If using env var pattern, must have at least access token var
  if (provider.tokenEnvVarPattern && !provider.tokenEnvVarPattern.accessToken) {
    throw new Error(`Provider ${provider.name} tokenEnvVarPattern must define accessToken variable`);
  }

  // Validate usePKCE is defined (required field)
  if (typeof provider.usePKCE !== 'boolean') {
    throw new Error(`Provider ${provider.name} must define usePKCE as a boolean`);
  }
}

/**
 * Get display information for a provider.
 * Used in UI to show provider details.
 *
 * @param provider - The OAuth provider definition
 * @returns Display information
 */
export function getProviderDisplayInfo(provider: OAuthProviderDefinition): {
  name: string;
  displayName: string;
  supportsRefresh: boolean;
  requiresSpecialAuth: boolean;
} {
  return {
    name: provider.name,
    displayName: provider.metadata?.displayName || provider.name,
    supportsRefresh: provider.metadata?.supportsRefresh ?? true,
    requiresSpecialAuth: provider.requiresSpecialAuth ?? false,
  };
}

/**
 * Format provider name for environment variable.
 * Converts provider name to uppercase with underscores.
 *
 * @param providerName - The provider name
 * @returns Formatted name for environment variables
 *
 * @example
 * formatProviderForEnvVar('github') => 'GITHUB'
 * formatProviderForEnvVar('google-cloud') => 'GOOGLE_CLOUD'
 */
export function formatProviderForEnvVar(providerName: string): string {
  return providerName.toUpperCase().replace(/-/g, '_');
}

/**
 * Handle browser authentication tokens for a provider.
 * Maps BrowserTokenResponse to environment variables based on provider config.
 *
 * @param provider - The OAuth provider definition
 * @param tokens - The browser tokens to store
 * @returns The environment variables to add to server config
 */
export async function handleBrowserTokens(
  provider: OAuthProviderDefinition,
  tokens: BrowserTokenResponse
): Promise<Record<string, string>> {
  log.info(`[OAuth Helper] Handling browser tokens for provider: ${provider.name}`);

  const envVars: Record<string, string> = {};

  // Use browser auth token mapping if available
  if (provider.browserAuthConfig?.tokenMapping) {
    const mapping = provider.browserAuthConfig.tokenMapping;

    if (tokens.primary_token && mapping.primary) {
      envVars[mapping.primary] = tokens.primary_token;
    }

    if (tokens.secondary_token && mapping.secondary) {
      envVars[mapping.secondary] = tokens.secondary_token;
    }
  } else if (provider.tokenEnvVarPattern) {
    // Fallback to standard pattern (for backward compatibility)
    if (tokens.primary_token && provider.tokenEnvVarPattern.accessToken) {
      envVars[provider.tokenEnvVarPattern.accessToken] = tokens.primary_token;
    }

    if (tokens.secondary_token && provider.tokenEnvVarPattern.refreshToken) {
      envVars[provider.tokenEnvVarPattern.refreshToken] = tokens.secondary_token;
    }
  }

  return envVars;
}
