import { OAuthServerMetadata, oauthDiscoveryService } from '@backend/services/oauth-discovery';
import log from '@backend/utils/logger';

import { OAuthProviderDefinition } from './provider-interface';
import { oauthProviders } from './provider-registry';

// Re-export database-free functions from provider-registry
export {
  oauthProviders,
  getOAuthProvider,
  hasOAuthProvider,
  getOAuthProviderNames,
  googleProvider,
  slackProvider,
  slackBrowserProvider,
  linkedinBrowserProvider,
} from './provider-registry';

/**
 * Helper function to get cached discovery metadata from database
 */
async function getCachedDiscoveryMetadata(serverId: string): Promise<OAuthServerMetadata | null> {
  try {
    // Import McpServerModel dynamically to avoid circular imports
    const { default: McpServerModel } = await import('@backend/models/mcpServer');
    const server = await McpServerModel.getById(serverId);

    if (server?.[0]?.oauthDiscoveryMetadata) {
      return JSON.parse(server[0].oauthDiscoveryMetadata);
    }
  } catch (error) {
    log.warn(`Failed to get cached discovery metadata for ${serverId}:`, error);
  }

  return null;
}

/**
 * Helper function to store discovery metadata in database
 */
async function storeDiscoveryMetadata(serverId: string, metadata: OAuthServerMetadata): Promise<void> {
  try {
    // Import McpServerModel dynamically to avoid circular imports
    const { default: McpServerModel } = await import('@backend/models/mcpServer');
    await McpServerModel.update(serverId, {
      oauthDiscoveryMetadata: JSON.stringify(metadata),
    });
  } catch (error) {
    log.warn(`Failed to store discovery metadata for ${serverId}:`, error);
  }
}

/**
 * Get OAuth provider with discovery enhancement
 * This function performs OAuth discovery and caches results
 */
export async function getOAuthProviderWithDiscovery(name: string, serverId?: string): Promise<OAuthProviderDefinition> {
  const staticProvider = oauthProviders[name.toLowerCase()];
  if (!staticProvider) {
    throw new Error(`OAuth provider '${name}' not configured`);
  }

  // If discovery is disabled or browser auth is enabled, use static/fallback config
  if (!staticProvider.discoveryConfig?.enabled || staticProvider.browserAuthConfig?.enabled) {
    return {
      ...staticProvider,
      authorizationUrl:
        staticProvider.discoveryConfig?.fallbackEndpoints?.authorization || staticProvider.authorizationUrl,
      tokenEndpoint: staticProvider.discoveryConfig?.fallbackEndpoints?.token,
      revocationEndpoint: staticProvider.discoveryConfig?.fallbackEndpoints?.revocation,
    };
  }

  // Check for cached discovery metadata
  if (serverId) {
    const cachedMetadata = await getCachedDiscoveryMetadata(serverId);
    if (cachedMetadata) {
      log.debug(`Using cached discovery metadata for ${name} (server: ${serverId})`);
      return {
        ...staticProvider,
        authorizationUrl: cachedMetadata.authorization_endpoint,
        tokenEndpoint: cachedMetadata.token_endpoint,
        revocationEndpoint: cachedMetadata.revocation_endpoint,
      };
    }
  }

  // Perform OAuth discovery
  try {
    log.info(`Performing OAuth discovery for ${name} (baseUrl: ${staticProvider.discoveryConfig.baseUrl})`);

    const metadata = await oauthDiscoveryService.discoverOAuthConfig(staticProvider.discoveryConfig.baseUrl);

    // Cache the discovered metadata if serverId provided
    if (serverId) {
      await storeDiscoveryMetadata(serverId, metadata);
      log.debug(`Cached discovery metadata for ${name} (server: ${serverId})`);
    }

    // Return provider with discovered endpoints
    return {
      ...staticProvider,
      authorizationUrl: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      revocationEndpoint: metadata.revocation_endpoint,
    };
  } catch (error) {
    log.warn(
      `OAuth discovery failed for ${name}, using fallback endpoints:`,
      error instanceof Error ? error.message : error
    );

    // Return provider with fallback endpoints
    return {
      ...staticProvider,
      authorizationUrl:
        staticProvider.discoveryConfig.fallbackEndpoints?.authorization || staticProvider.authorizationUrl,
      tokenEndpoint: staticProvider.discoveryConfig.fallbackEndpoints?.token,
      revocationEndpoint: staticProvider.discoveryConfig.fallbackEndpoints?.revocation,
    };
  }
}
