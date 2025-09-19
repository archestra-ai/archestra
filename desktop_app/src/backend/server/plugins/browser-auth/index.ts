/**
 * Browser Authentication Plugin Index
 *
 * Main export for browser authentication routes and functionality
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import browserAuthRoutes from './routes';

/**
 * Browser Authentication Plugin
 *
 * This plugin handles browser-based authentication functionality including:
 * - Browser authentication route handlers
 * - Browser-based authentication providers
 * - Token extraction and management
 */
const browserAuthPlugin: FastifyPluginAsyncZod = async (fastify) => {
  // Register browser authentication routes
  await fastify.register(browserAuthRoutes);
};

export default browserAuthPlugin;

// Re-export database-free functions from provider-registry
export {
  getBrowserAuthProvider,
  hasBrowserAuthProvider,
  getBrowserAuthProviderNames,
  browserAuthProviders,
  // Legacy exports for backwards compatibility
  getOAuthProvider,
  hasOAuthProvider,
  getOAuthProviderNames,
  oauthProviders,
  slackBrowserProvider,
  linkedinBrowserProvider,
} from './provider-registry';

// Re-export types for external use
export type {
  BrowserAuthProviderDefinition,
  BrowserAuthProviderRegistry,
  BrowserTokenResponse,
  // Legacy types for backwards compatibility
  BrowserAuthProviderDefinition as OAuthProviderDefinition,
  BrowserAuthProviderRegistry as OAuthProviderRegistry,
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
