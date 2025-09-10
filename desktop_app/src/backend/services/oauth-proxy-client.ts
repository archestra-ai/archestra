/**
 * OAuth Proxy Client Service
 *
 * Handles communication with the oauth-proxy server to securely exchange tokens
 * without exposing client secrets in the desktop application.
 */
import log from '@backend/utils/logger';

export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthProxyRequest {
  grant_type: 'authorization_code' | 'refresh_token';
  mcp_server_id: string;
  token_endpoint: string;
  client_secret: 'REDACTED';
  [key: string]: any;
}

export class OAuthProxyClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.OAUTH_PROXY_URL || 'https://oauth.dev.archestra.ai/oauth/callback';
  }

  /**
   * Exchange authorization code for access tokens via generic OAuth route
   */
  async exchangeGenericOAuthTokens(
    mcpServerId: string,
    tokenEndpoint: string,
    params: Record<string, any>
  ): Promise<OAuthTokens> {
    log.info(`Exchanging generic OAuth tokens via oauth-proxy for MCP server: ${mcpServerId}`);

    const requestBody = {
      grant_type: params.grant_type,
      mcp_server_id: mcpServerId,
      token_endpoint: tokenEndpoint,
      code: params.code,
      redirect_uri: params.redirect_uri,
      client_secret: 'REDACTED', // Will be replaced by proxy with real secret
    };

    const proxyUrl = `${this.baseUrl}/oauth/token`;

    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        log.error(`Generic OAuth proxy token exchange failed:`, errorData);
        throw new Error(`OAuth proxy failed: ${response.status} ${response.statusText}`);
      }

      const tokens = await response.json();
      log.info(`Generic OAuth token exchange successful via oauth-proxy for MCP server: ${mcpServerId}`);
      return tokens;
    } catch (error) {
      log.error(`Generic OAuth proxy token exchange error for ${mcpServerId}:`, error);
      throw new Error(
        `Generic OAuth proxy token exchange failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Exchange authorization code or refresh token for access tokens via oauth-proxy (MCP SDK route)
   */
  async exchangeTokens(
    mcpServerId: string,
    serverUrl: string, // Now expects MCP server URL for discovery, not token endpoint
    params: Record<string, any>
  ): Promise<OAuthTokens> {
    log.info(`Exchanging tokens via oauth-proxy for MCP server: ${mcpServerId}`);

    // Transform params for MCP SDK route
    const requestBody = {
      authorization_code: params.code,
      code_verifier: params.code_verifier,
      redirect_uri: params.redirect_uri,
      resource: params.resource,
      authorization_server_url: serverUrl, // Pass MCP server URL for OAuth discovery
    };

    // Use the new MCP SDK-based proxy route for perfect compatibility
    const proxyUrl = `${this.baseUrl}/mcp/sdk-token/${mcpServerId}`;

    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(requestBody),
        // Add timeout for safety
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        log.error(`OAuth proxy token exchange failed:`, errorData);
        throw new Error(`OAuth proxy failed: ${response.status} ${response.statusText}`);
      }

      const tokens = await response.json();
      log.info(`Token exchange successful via oauth-proxy for MCP server: ${mcpServerId}`);
      return tokens;
    } catch (error) {
      log.error(`OAuth proxy token exchange error for ${mcpServerId}:`, error);
      throw new Error(`OAuth proxy token exchange failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Revoke tokens via oauth-proxy
   */
  async revokeTokens(mcpServerId: string, revocationEndpoint: string, token: string): Promise<void> {
    if (!revocationEndpoint) {
      log.info(`No revocation endpoint provided for MCP server ${mcpServerId}, skipping revocation`);
      return;
    }

    log.info(`Revoking tokens via oauth-proxy for MCP server: ${mcpServerId}`);

    try {
      const response = await fetch(`${this.baseUrl}/oauth/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          mcp_server_id: mcpServerId,
          revocation_endpoint: revocationEndpoint,
          token,
        }),
        // Add timeout for safety
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        log.warn(`Token revocation failed (non-critical):`, errorData);
        // Don't throw error for revocation failures - they're not critical
        return;
      }

      log.info(`Token revocation successful via oauth-proxy for MCP server: ${mcpServerId}`);
    } catch (error) {
      log.warn(`Token revocation error (non-critical) for ${mcpServerId}:`, error);
      // Don't throw error for revocation failures - they're not critical
    }
  }

  /**
   * Check if oauth-proxy server is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch (error) {
      log.warn(`OAuth proxy health check failed:`, error);
      return false;
    }
  }

  /**
   * Get allowed destinations from oauth-proxy
   */
  async getAllowedDestinations(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.allowedDestinations || [];
    } catch (error) {
      log.warn(`Failed to get allowed destinations from oauth-proxy:`, error);
      return [];
    }
  }
}

// Export a default instance
export const oauthProxyClient = new OAuthProxyClient();
