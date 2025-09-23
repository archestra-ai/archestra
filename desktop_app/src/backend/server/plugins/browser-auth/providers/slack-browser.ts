import { BrowserAuthProviderDefinition } from '../provider-interface';
import { buildSlackTokenExtractionScript, isSlackWorkspacePage } from '../utils/slack-token-extractor';

export const slackBrowserProvider: BrowserAuthProviderDefinition = {
  name: 'slack-browser',

  // Browser-based authentication configuration
  browserAuthConfig: {
    enabled: true,
    loginUrl: 'https://slack.com/signin',
    workspacePattern: /slack:\/\/([A-Z0-9]+)/,

    // Map browser tokens to environment variables
    tokenMapping: {
      primary: 'SLACK_MCP_XOXC_TOKEN',
      secondary: 'SLACK_MCP_XOXD_TOKEN',
    },

    /**
     * Allow navigation to official Slack domains and Google + AppleSSO providers
     */
    navigationRules: (url: string) => {
      //
      try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname;

        const isSlackDomain =
          hostname === 'slack.com' ||
          hostname === 'app.slack.com' ||
          (hostname.endsWith('.slack.com') && hostname.length > '.slack.com'.length);

        const isGoogleOAuth =
          hostname === 'accounts.google.com' || hostname === 'apis.google.com' || hostname.endsWith('.google.com');

        const isAppleOAuth = hostname === 'appleid.apple.com' || hostname.endsWith('.apple.com');

        return isSlackDomain || isGoogleOAuth || isAppleOAuth;
      } catch (e) {
        // If URL parsing fails, deny navigation
        return false;
      }
    },

    extractTokens: async (windowWithContext: any) => {
      // Extract the actual window parts and context
      const { webContents, session, context } = windowWithContext;
      const url = webContents.getURL();

      console.log('[Slack Browser Auth] Attempting token extraction on:', url);

      // Only try to extract on workspace pages
      if (!isSlackWorkspacePage(url)) {
        console.log('[Slack Browser Auth] Not a workspace page, skipping token extraction');
        return null;
      }

      console.log('[Slack Browser Auth] On workspace page, extracting tokens...');

      // Get xoxd token from cookies
      const cookies = await session.cookies.get({ name: 'd' });
      const dCookie = cookies.length > 0 ? cookies[0] : null;
      const xoxdToken = dCookie ? dCookie.value : null;

      console.log('[Slack Browser Auth] Found xoxd token:', !!xoxdToken);

      // Pass the workspace ID from context if available
      const contextWorkspaceId = context?.workspaceId || '';

      // Get xoxc token from localStorage using extraction script
      const extractionScript = buildSlackTokenExtractionScript(contextWorkspaceId);
      const result = await webContents.executeJavaScript(extractionScript);

      console.log('[Slack Browser Auth] Token extraction result:', {
        success: result.success,
        hasXoxcToken: !!result.xoxcToken,
        hasXoxdToken: !!xoxdToken,
        error: result.error,
      });

      if (result.success && result.xoxcToken && xoxdToken) {
        // Log success
        console.log(`[Slack Browser Auth] Successfully extracted tokens for workspace ${result.workspaceId}`);

        // Return proper BrowserTokenResponse
        return {
          primary_token: result.xoxcToken,
          secondary_token: xoxdToken,
          workspace_id: result.workspaceId,
        };
      }

      // Log the error for debugging
      if (!result.success) {
        console.error('[Slack Browser Auth] Token extraction failed:', result.error);
      } else if (!xoxdToken) {
        console.error('[Slack Browser Auth] Missing xoxd token (d cookie)');
      } else if (!result.xoxcToken) {
        console.error('[Slack Browser Auth] Missing xoxc token');
      }

      return null;
    },
  },

  metadata: {
    displayName: 'Slack (Browser Auth)',
    documentationUrl: 'https://api.slack.com/authentication',
    notes: 'Direct browser authentication using xoxc/xoxd tokens. No OAuth app required.',
  },
};
