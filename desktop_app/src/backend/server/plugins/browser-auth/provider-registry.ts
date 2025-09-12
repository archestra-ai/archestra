import { BrowserAuthProviderDefinition, BrowserAuthProviderRegistry } from './provider-interface';
import { linkedinBrowserProvider } from './providers/linkedin-browser';
import { slackBrowserProvider } from './providers/slack-browser';

/**
 * Registry of browser authentication providers.
 * These providers extract tokens directly from authenticated browser sessions.
 *
 * This file contains ONLY database-free provider registry functions
 * for use in the main process without pulling in better-sqlite3.
 */
export const browserAuthProviders: BrowserAuthProviderRegistry = {
  'slack-browser': slackBrowserProvider,
  'linkedin-browser': linkedinBrowserProvider,
};

/**
 * Get browser authentication provider definition
 */
export function getBrowserAuthProvider(name: string): BrowserAuthProviderDefinition {
  const provider = browserAuthProviders[name.toLowerCase()];
  if (!provider) {
    throw new Error(`Browser auth provider '${name}' not configured`);
  }
  return provider;
}

/**
 * Check if a browser authentication provider is configured
 */
export function hasBrowserAuthProvider(name: string): boolean {
  return name.toLowerCase() in browserAuthProviders;
}

/**
 * Get all configured browser authentication provider names
 */
export function getBrowserAuthProviderNames(): string[] {
  return Object.keys(browserAuthProviders);
}

// Legacy aliases for backwards compatibility
export const getOAuthProvider = getBrowserAuthProvider;
export const hasOAuthProvider = hasBrowserAuthProvider;
export const getOAuthProviderNames = getBrowserAuthProviderNames;
export const oauthProviders = browserAuthProviders;

// Re-export individual providers for direct access if needed
export { slackBrowserProvider, linkedinBrowserProvider };
