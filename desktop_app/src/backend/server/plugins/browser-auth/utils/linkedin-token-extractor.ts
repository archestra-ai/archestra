/**
 * LinkedIn Token Extraction Utilities
 *
 * Utilities for extracting LinkedIn authentication tokens from the browser
 * Uses the li_at cookie for authentication
 */

interface LinkedInTokenExtractionResult {
  success: boolean;
  liAtToken?: string;
  error?: string;
}

/**
 * Extract LinkedIn tokens from cookies
 * The li_at cookie is the main authentication token for LinkedIn API
 * This runs in the browser context
 */
export const LINKEDIN_TOKEN_EXTRACTION_SCRIPT = `
  (function() {
    try {
      console.log('[LinkedIn Token Extraction] Starting token extraction...');
      console.log('[LinkedIn Token Extraction] Current URL:', window.location.href);
      
      // Check if we're on LinkedIn
      const hostname = window.location.hostname;
      if (!hostname.includes('linkedin.com')) {
        return { success: false, error: 'Not on LinkedIn domain' };
      }
      
      // The li_at token is stored in cookies, not accessible via JavaScript
      // We'll return success to indicate we're on the right page
      // The actual cookie extraction happens in the main process
      return { success: true };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  })();
`;

/**
 * Build the LinkedIn token extraction script
 */
export function buildLinkedInTokenExtractionScript(): string {
  return LINKEDIN_TOKEN_EXTRACTION_SCRIPT;
}

/**
 * Validate LinkedIn page URL
 */
export function isLinkedInAuthenticatedPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    // Check if we're on LinkedIn and likely authenticated (on feed or profile pages)
    return (
      parsedUrl.hostname.includes('linkedin.com') &&
      (parsedUrl.pathname.startsWith('/feed') ||
        parsedUrl.pathname.startsWith('/in/') ||
        parsedUrl.pathname.startsWith('/mynetwork') ||
        parsedUrl.pathname.startsWith('/jobs') ||
        parsedUrl.pathname.startsWith('/messaging'))
    );
  } catch {
    return false;
  }
}

/**
 * Check if URL is LinkedIn login page
 */
export function isLinkedInLoginPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname.includes('linkedin.com') &&
      (parsedUrl.pathname.includes('/login') ||
        parsedUrl.pathname.includes('/signin') ||
        parsedUrl.pathname === '/' ||
        parsedUrl.pathname.includes('/checkpoint'))
    );
  } catch {
    return false;
  }
}
