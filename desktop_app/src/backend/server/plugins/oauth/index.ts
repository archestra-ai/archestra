import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import oauthRoutes from './routes';

/**
 * OAuth Plugin
 *
 * This plugin handles all OAuth-related functionality including:
 * - OAuth provider configurations
 * - OAuth authentication flows
 * - Token management
 * - Provider-specific implementations
 */
const oauthPlugin: FastifyPluginAsyncZod = async (fastify) => {
  // Register OAuth routes
  await fastify.register(oauthRoutes);
};

// Re-export everything from providers and provider-interface for use in other parts of the app
export {
  getOAuthProvider,
  getOAuthProviderWithDiscovery,
  hasOAuthProvider,
  getOAuthProviderNames,
  oauthProviders,
  googleProvider,
  slackProvider,
  slackBrowserProvider,
} from './providers';
export type {
  OAuthProviderDefinition,
  OAuthProviderRegistry,
  TokenResponse,
  BrowserTokenResponse,
} from './provider-interface';

// Re-export utilities for convenience (optional, only if needed externally)
export { handleProviderTokens, validateProvider, getAuthorizationParams } from './utils/oauth-provider-helper';
export { generateCodeChallenge, generateCodeVerifier, generateState } from './utils/pkce';
export { getOAuthProxyUrl } from './utils/oauth-config';
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

export default oauthPlugin;
