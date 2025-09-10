/**
 * OAuth Plugin Index
 *
 * Main export for OAuth routes plugin and browser authentication functionality
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import oauthRoutes from './routes';

/**
 * OAuth Plugin
 *
 * This plugin handles all OAuth-related functionality including:
 * - OAuth route handlers for MCP OAuth compatibility
 * - Browser-based authentication providers
 * - Token extraction and management
 */
const oauthPlugin: FastifyPluginAsyncZod = async (fastify) => {
  // Register OAuth routes
  await fastify.register(oauthRoutes);
};

export default oauthPlugin;

// Re-export database-free functions from provider-registry
export {
  getOAuthProvider,
  hasOAuthProvider,
  getOAuthProviderNames,
  oauthProviders,
  slackBrowserProvider,
  linkedinBrowserProvider,
} from './provider-registry';

// Re-export types for external use
export type {
  OAuthProviderDefinition,
  OAuthProviderRegistry,
  BrowserTokenResponse,
} from './provider-interface';

// Re-export utilities for convenience
export {
  BROWSER_AUTH_WINDOW_CONFIG,
  getProviderSessionPartition,
  setupTokenExtractionHandlers,
} from './utils/browser-auth-utils';

export {
  buildSlackTokenExtractionScript,
  buildSlackWorkspaceUrl,
  extractWorkspaceIdFromProtocol,
  isSlackWorkspacePage,
} from './utils/slack-token-extractor';

export {
  buildLinkedInTokenExtractionScript,
  isLinkedInAuthenticatedPage,
  isLinkedInLoginPage,
} from './utils/linkedin-token-extractor';
