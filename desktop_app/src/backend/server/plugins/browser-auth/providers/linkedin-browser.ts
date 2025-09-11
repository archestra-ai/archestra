import { BrowserAuthProviderDefinition } from '../provider-interface';
import {
  buildLinkedInTokenExtractionScript,
  isLinkedInAuthenticatedPage,
  isLinkedInLoginPage,
} from '../utils/linkedin-token-extractor';

export const linkedinBrowserProvider: BrowserAuthProviderDefinition = {
  name: 'linkedin-browser',

  // Browser-based authentication configuration
  browserAuthConfig: {
    enabled: true,
    loginUrl: 'https://www.linkedin.com/login',

    // Map browser tokens to environment variables
    tokenMapping: {
      primary: 'LINKEDIN_COOKIE', // Changed to match what the container expects
    },

    navigationRules: (url: string) => {
      // Only allow navigation to official LinkedIn domains
      try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname;
        return (
          hostname === 'linkedin.com' ||
          hostname === 'www.linkedin.com' ||
          (hostname.endsWith('.linkedin.com') && hostname.length > '.linkedin.com'.length)
        );
      } catch (e) {
        // If URL parsing fails, deny navigation
        return false;
      }
    },

    extractTokens: async (windowWithContext: any) => {
      // Extract the actual window parts and context
      const { webContents, session, context } = windowWithContext;
      const url = webContents.getURL();

      console.log('[LinkedIn Browser Auth] Attempting token extraction on:', url);

      // Check if we're on a login page
      if (isLinkedInLoginPage(url)) {
        console.log('[LinkedIn Browser Auth] Still on login page, waiting for authentication');
        return null;
      }

      // Only try to extract on authenticated pages
      if (!isLinkedInAuthenticatedPage(url)) {
        console.log('[LinkedIn Browser Auth] Not an authenticated page, waiting for user to log in');
        return null;
      }

      console.log('[LinkedIn Browser Auth] On authenticated page, extracting li_at cookie...');

      // Get li_at token from cookies
      const cookies = await session.cookies.get({
        url: 'https://www.linkedin.com',
        name: 'li_at',
      });

      const liAtCookie = cookies.length > 0 ? cookies[0] : null;
      const liAtToken = liAtCookie ? liAtCookie.value : null;

      console.log('[LinkedIn Browser Auth] Found li_at token:', !!liAtToken);

      // Execute the extraction script to verify we're on LinkedIn
      const extractionScript = buildLinkedInTokenExtractionScript();
      const result = await webContents.executeJavaScript(extractionScript);

      console.log('[LinkedIn Browser Auth] Page verification result:', {
        success: result.success,
        hasLiAtToken: !!liAtToken,
        error: result.error,
      });

      if (result.success && liAtToken) {
        // Log success
        console.log('[LinkedIn Browser Auth] Successfully extracted li_at token');

        // Return proper BrowserTokenResponse
        return {
          primary_token: 'li_at=' + liAtToken,
        };
      }

      // Log the error for debugging
      if (!result.success) {
        console.error('[LinkedIn Browser Auth] Page verification failed:', result.error);
      } else if (!liAtToken) {
        console.error('[LinkedIn Browser Auth] Missing li_at token (cookie not found)');
      }

      return null;
    },
  },

  metadata: {
    displayName: 'LinkedIn (Browser Auth)',
    documentationUrl: 'https://github.com/stickerdaniel/linkedin-mcp-server',
    notes: 'Direct browser authentication using li_at cookie. No OAuth app required. Based on linkedin-mcp-server.',
  },
};
