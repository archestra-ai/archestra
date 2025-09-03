import log from '@backend/utils/logger';

/**
 * OAuth Server Metadata as defined by RFC 8414
 * https://tools.ietf.org/html/rfc8414
 */
export interface OAuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported?: string[];
  issuer?: string;
}

/**
 * OAuth Discovery Service implementing RFC 8414
 * OAuth 2.0 Authorization Server Metadata discovery
 */
export class OAuthDiscoveryService {
  /**
   * Discover OAuth configuration from a base URL
   * Tries standard discovery endpoints per RFC 8414
   */
  async discoverOAuthConfig(baseUrl: string): Promise<OAuthServerMetadata> {
    const discoveryUrls = [
      `${baseUrl}/.well-known/oauth-authorization-server`,
      `${baseUrl}/.well-known/openid_configuration`,
    ];

    log.info(`Starting OAuth discovery for base URL: ${baseUrl}`);

    for (const url of discoveryUrls) {
      try {
        log.debug(`Trying discovery endpoint: ${url}`);

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Archestra-OAuth-Discovery/1.0',
          },
          // 10 second timeout for discovery requests
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          const metadata = await response.json();
          const validatedMetadata = this.validateAndNormalizeMetadata(metadata);

          log.info(`OAuth discovery successful for ${baseUrl} via ${url}`);
          log.debug('Discovered metadata:', validatedMetadata);

          return validatedMetadata;
        } else {
          log.debug(`Discovery endpoint ${url} returned status ${response.status}`);
        }
      } catch (error) {
        log.debug(`Discovery failed for ${url}:`, error instanceof Error ? error.message : error);
        continue;
      }
    }

    throw new Error(`OAuth discovery failed for ${baseUrl} - no valid endpoints found`);
  }

  /**
   * Validate and normalize discovered OAuth metadata
   * Ensures required fields are present and provides sensible defaults
   */
  private validateAndNormalizeMetadata(metadata: any): OAuthServerMetadata {
    if (!metadata || typeof metadata !== 'object') {
      throw new Error('Invalid OAuth metadata: not a valid JSON object');
    }

    // Required fields per RFC 8414
    if (!metadata.authorization_endpoint || typeof metadata.authorization_endpoint !== 'string') {
      throw new Error('Invalid OAuth metadata: missing or invalid authorization_endpoint');
    }

    if (!metadata.token_endpoint || typeof metadata.token_endpoint !== 'string') {
      throw new Error('Invalid OAuth metadata: missing or invalid token_endpoint');
    }

    // Validate URLs
    try {
      new URL(metadata.authorization_endpoint);
      new URL(metadata.token_endpoint);

      if (metadata.revocation_endpoint) {
        new URL(metadata.revocation_endpoint);
      }
    } catch (error) {
      throw new Error('Invalid OAuth metadata: invalid URL format in endpoints');
    }

    return {
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      revocation_endpoint: metadata.revocation_endpoint || undefined,
      scopes_supported: Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : [],
      response_types_supported: Array.isArray(metadata.response_types_supported)
        ? metadata.response_types_supported
        : ['code'],
      grant_types_supported: Array.isArray(metadata.grant_types_supported)
        ? metadata.grant_types_supported
        : ['authorization_code'],
      code_challenge_methods_supported: Array.isArray(metadata.code_challenge_methods_supported)
        ? metadata.code_challenge_methods_supported
        : ['S256'],
      token_endpoint_auth_methods_supported: Array.isArray(metadata.token_endpoint_auth_methods_supported)
        ? metadata.token_endpoint_auth_methods_supported
        : ['client_secret_post', 'client_secret_basic'],
      issuer: metadata.issuer || undefined,
    };
  }

  /**
   * Check if a provider supports PKCE based on discovered metadata
   */
  supportsPKCE(metadata: OAuthServerMetadata): boolean {
    return (
      metadata.code_challenge_methods_supported.includes('S256') ||
      metadata.code_challenge_methods_supported.includes('plain')
    );
  }

  /**
   * Get supported scopes from discovered metadata
   */
  getSupportedScopes(metadata: OAuthServerMetadata): string[] {
    return metadata.scopes_supported || [];
  }
}

// Export singleton instance
export const oauthDiscoveryService = new OAuthDiscoveryService();
