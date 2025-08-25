/**
 * OAuth Configuration Utilities
 *
 * Centralized configuration management for OAuth-related settings
 */

/**
 * Get the OAuth proxy base URL based on environment
 */
export function getOAuthProxyUrl(): string {
  return (
    process.env.OAUTH_PROXY_URL ||
    (process.env.NODE_ENV === 'development'
      ? 'https://localhost:8080'
      : 'https://oauth-proxy-new-354887056155.europe-west1.run.app')
  );
}

/**
 * Get the redirect URI for OAuth callbacks
 */
export function getOAuthRedirectUri(): string {
  const proxyBase = getOAuthProxyUrl();
  return `${proxyBase}/callback/archestra`;
}

/**
 * OAuth state cleanup configuration
 */
export const OAUTH_STATE_CLEANUP = {
  /** How often to run cleanup (milliseconds) */
  interval: 30 * 1000, // 30 seconds
  /** How long OAuth states are valid (milliseconds) */
  maxAge: 10 * 60 * 1000, // 10 minutes
} as const;

/**
 * OAuth request configuration
 */
export const OAUTH_REQUEST_CONFIG = {
  /** Request timeout in milliseconds */
  timeout: 30000,
  /** Whether to reject unauthorized certificates in production */
  rejectUnauthorized: process.env.NODE_ENV === 'production',
} as const;
