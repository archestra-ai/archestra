/**
 * OAuth Provider Configuration for OAuth Proxy
 * 
 * Defines trusted OAuth endpoints to prevent SSRF attacks while keeping
 * the proxy generic and easy to configure.
 */

/**
 * Provider-based allowlist of trusted OAuth endpoints
 * Maps provider names to arrays of allowed hostnames
 */
export const TRUSTED_PROVIDERS = {
  google: ['oauth2.googleapis.com', 'accounts.google.com'],
  slack: ['slack.com', 'api.slack.com'],
  microsoft: ['login.microsoftonline.com'], 
  github: ['github.com'],
  atlassian: ['auth.atlassian.com'],
  
  // Development flexibility - allows any URL
  dev: ['*'],
  localhost: ['*'],
};

/**
 * Validate that a token endpoint URL is allowed for the given provider
 * 
 * @param {string} url - The token endpoint URL to validate
 * @param {string} provider - The OAuth provider name
 * @returns {boolean} True if the URL is allowed for this provider
 */
export function isValidOAuthEndpoint(url, provider) {
  try {
    const hostname = new URL(url).hostname;
    const allowedHosts = TRUSTED_PROVIDERS[provider.toLowerCase()];
    
    if (!allowedHosts) {
      return false;
    }
    
    // Wildcard allows any URL (useful for development)
    if (allowedHosts.includes('*')) {
      return true;
    }
    
    // Check if hostname is in the allowed list
    return allowedHosts.includes(hostname);
  } catch (error) {
    return false;
  }
}

/**
 * Get list of supported OAuth providers
 * 
 * @returns {string[]} Array of supported provider names
 */
export function getSupportedProviders() {
  return Object.keys(TRUSTED_PROVIDERS);
}