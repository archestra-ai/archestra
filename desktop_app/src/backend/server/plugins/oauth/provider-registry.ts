import { OAuthProviderDefinition, OAuthProviderRegistry } from './provider-interface';
import { linkedinBrowserProvider } from './providers/linkedin-browser';
import { slackBrowserProvider } from './providers/slack-browser';

/**
 * Registry of OAuth providers with browser-based authentication.
 * These providers extract tokens directly from authenticated browser sessions.
 *
 * This file contains ONLY database-free provider registry functions
 * for use in the main process without pulling in better-sqlite3.
 */
export const oauthProviders: OAuthProviderRegistry = {
  'slack-browser': slackBrowserProvider,
  'linkedin-browser': linkedinBrowserProvider,
};

/**
 * Get OAuth provider definition
 */
export function getOAuthProvider(name: string): OAuthProviderDefinition {
  const provider = oauthProviders[name.toLowerCase()];
  if (!provider) {
    throw new Error(`OAuth provider '${name}' not configured`);
  }
  return provider;
}

/**
 * Check if a provider is configured
 */
export function hasOAuthProvider(name: string): boolean {
  return name.toLowerCase() in oauthProviders;
}

/**
 * Get all configured provider names
 */
export function getOAuthProviderNames(): string[] {
  return Object.keys(oauthProviders);
}

// Re-export individual providers for direct access if needed
export { slackBrowserProvider, linkedinBrowserProvider };
