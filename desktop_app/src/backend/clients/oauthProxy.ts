/**
 * OAuth Proxy Client Service
 *
 * Handles communication with the oauth-proxy server to securely exchange tokens
 * without exposing client secrets in the desktop application.
 */
import config from '@backend/config';
import log from '@backend/utils/logger';

const { url: baseUrl } = config.oauthProxy;

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

class OAuthProxyClient {
  /**
   * Exchange authorization code for access tokens via generic OAuth route
   */
  static async exchangeGenericOAuthTokens(
    mcpServerId: string,
    tokenEndpoint: string,
    params: Record<string, any>
  ): Promise<OAuthTokens> {
    log.info(`Exchanging generic OAuth tokens via oauth-proxy for MCP server: ${mcpServerId}`);

    try {
      const response = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: params.grant_type,
          mcp_server_id: mcpServerId,
          token_endpoint: tokenEndpoint,
          code: params.code,
          redirect_uri: params.redirect_uri,
          client_secret: 'REDACTED', // Will be replaced by proxy with real secret
        }),
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
  static async exchangeTokens(
    mcpServerId: string,
    serverUrl: string, // Now expects MCP server URL for discovery, not token endpoint
    params: Record<string, any>
  ): Promise<OAuthTokens> {
    log.info(`Exchanging tokens via oauth-proxy for MCP server: ${mcpServerId}`);

    try {
      // Use the new MCP SDK-based proxy route for perfect compatibility
      const response = await fetch(`${baseUrl}/mcp/sdk-token/${mcpServerId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // Transform params for MCP SDK route
        body: JSON.stringify({
          authorization_code: params.code,
          code_verifier: params.code_verifier,
          redirect_uri: params.redirect_uri,
          resource: params.resource,
          authorization_server_url: serverUrl, // Pass MCP server URL for OAuth discovery
        }),
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
}

export default OAuthProxyClient;
