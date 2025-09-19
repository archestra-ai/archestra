/**
 * OAuth Destination Configuration for OAuth Proxy
 * 
 * Defines allowed OAuth endpoints to prevent SSRF attacks while keeping
 * the proxy generic and easy to configure.
 */

/**
 * Simple allowlist of trusted OAuth destination hostnames
 * Used for SSRF protection - only these hostnames are allowed
 */
export const ALLOWED_DESTINATIONS = [
  'oauth2.googleapis.com',
  'accounts.google.com',
  'slack.com', 
  'api.slack.com',
  'github.com',
  'api.githubcopilot.com',
  'login.microsoftonline.com',
  'auth.atlassian.com',
  
  // Development flexibility
  'localhost',
  '127.0.0.1',
];

/**
 * Validate that a token endpoint URL is allowed
 * 
 * @param {string} url - The token endpoint URL to validate
 * @returns {boolean} True if the URL hostname is in the allowlist
 */
export function isValidOAuthEndpoint(url) {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_DESTINATIONS.includes(hostname);
  } catch (error) {
    return false;
  }
}

/**
 * Get list of allowed OAuth destination hostnames
 * 
 * @returns {string[]} Array of allowed hostnames
 */
export function getAllowedDestinations() {
  return ALLOWED_DESTINATIONS;
}