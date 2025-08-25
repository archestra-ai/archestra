import {
  buildSlackTokenExtractionScript,
  buildSlackWorkspaceUrl,
  extractWorkspaceIdFromProtocol,
  isSlackWorkspacePage,
} from '@backend/utils/slack-token-extractor';

import {
  BrowserTokenResponse,
  OAuthProviderDefinition,
  OAuthProviderRegistry,
  TokenResponse,
} from './oauth-provider-interface';

/**
 * Registry of OAuth providers with extensible token handling.
 * These are PUBLIC client IDs (not secrets) - safe to hardcode.
 * The secrets are stored in the OAuth proxy server.
 */
export const oauthProviders: OAuthProviderRegistry = {
  google: {
    name: 'google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    usePKCE: true,
    clientId:
      process.env.GOOGLE_OAUTH_CLIENT_ID || '354887056155-5b4rlcofccknibd4fv3ldud9vvac3rdf.apps.googleusercontent.com',

    // Google uses special env vars that will be processed into a file at container startup
    tokenEnvVarPattern: {
      accessToken: 'GOOGLE_OAUTH_TOKEN',
      refreshToken: 'GOOGLE_OAUTH_REFRESH_TOKEN',
      expiryDate: 'GOOGLE_OAUTH_EXPIRY',
    },

    // Additional authorization parameters to get user info
    authorizationParams: {
      access_type: 'offline',
      prompt: 'consent',
    },

    metadata: {
      displayName: 'Google',
      documentationUrl: 'https://developers.google.com/identity/protocols/oauth2',
      supportsRefresh: true,
      notes: 'Token is written to ~/.google_workspace_mcp/credentials/{email}.json at container startup',
    },
  },

  slack: {
    name: 'slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    scopes: [
      'channels:read',
      'channels:history',
      'chat:write',
      'groups:read',
      'groups:history',
      'im:read',
      'im:history',
      'mpim:read',
      'mpim:history',
      'users:read',
      'users:read.email',
      'team:read',
      'files:read',
      'files:write',
    ],
    usePKCE: true,
    clientId: process.env.SLACK_OAUTH_CLIENT_ID || '9210991658150.9211748349222',

    // Slack uses standard env vars
    tokenEnvVarPattern: {
      accessToken: 'SLACK_MCP_ACCESS_TOKEN',
      // Slack doesn't use refresh tokens
    },

    // Slack-specific authorization parameters
    authorizationParams: {
      user_scope: 'identity.basic,identity.email,identity.team,identity.avatar',
    },

    // Slack supports browser-based auth as an alternative
    requiresSpecialAuth: true,

    metadata: {
      displayName: 'Slack',
      documentationUrl: 'https://api.slack.com/authentication/oauth-v2',
      supportsRefresh: false,
      notes: 'Tokens do not expire. Supports both OAuth and browser-based authentication.',
    },
  },

  'slack-browser': {
    name: 'slack-browser',
    authorizationUrl: '', // Not used for browser auth
    scopes: [], // Not used for browser auth
    usePKCE: false, // Not used for browser auth
    clientId: 'browser-auth', // Placeholder

    // Token pattern is required but handled by browser auth mapping
    tokenEnvVarPattern: {
      accessToken: 'SLACK_MCP_XOXC_TOKEN', // Maps to primary_token
      refreshToken: 'SLACK_MCP_XOXD_TOKEN', // Maps to secondary_token
    },

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

      navigationRules: (url: string) => {
        // Only allow navigation to official Slack domains
        return (
          url.startsWith('https://slack.com/') ||
          url.startsWith('https://app.slack.com/') ||
          url.includes('.slack.com/')
        );
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
      supportsRefresh: false,
      notes: 'Direct browser authentication using xoxc/xoxd tokens. No OAuth app required.',
    },
  },
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
