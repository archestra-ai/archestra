import log from '@backend/utils/logger';

import { OAuthProviderDefinition, TokenResponse } from '../provider-interface';

/**
 * Helper function to extract email from Google ID token
 * ID tokens are JWT tokens with payload containing user info
 */
function extractEmailFromIdToken(idToken: string): string | undefined {
  try {
    // ID token is a JWT: header.payload.signature
    const parts = idToken.split('.');
    if (parts.length !== 3) return undefined;

    // Decode the payload (base64url encoded)
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const data = JSON.parse(payload);

    return data.email;
  } catch (error) {
    log.error('Failed to extract email from ID token:', error);
    return undefined;
  }
}

/**
 * Fetch user email from Google's UserInfo API using the access token
 */
async function fetchGoogleUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.statusText}`);
    }

    const userInfo = await response.json();
    return userInfo.email;
  } catch (error) {
    log.error('Failed to fetch Google user info:', error);
    return undefined;
  }
}

export const googleProvider: OAuthProviderDefinition = {
  name: 'google',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  scopes: [
    'openid', // Required for ID token
    'email', // Required for email in ID token
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

  /**
   * Extract user email from Google OAuth tokens
   * Tries ID token first, then falls back to UserInfo API
   */
  extractUserEmail: async (tokens: TokenResponse): Promise<string | undefined> => {
    log.info('Google provider: extracting user email...');

    let email: string | undefined;

    // Method 1: Try to extract from ID token
    if (tokens.id_token) {
      log.info('Attempting to extract email from ID token');
      email = extractEmailFromIdToken(tokens.id_token);
      if (email) {
        log.info(`Successfully extracted email from ID token: ${email}`);
        return email;
      }
    }

    // Method 2: If no email from ID token, fetch from UserInfo API
    if (!email && tokens.access_token) {
      log.info('ID token extraction failed or not present, fetching from UserInfo API');
      email = await fetchGoogleUserEmail(tokens.access_token);
      if (email) {
        log.info(`Successfully fetched email from UserInfo API: ${email}`);
        return email;
      }
    }

    // No email could be extracted
    log.warn('Could not extract email from Google OAuth tokens');
    return undefined;
  },

  /**
   * Insert Google Workspace credentials file into container before running the main command
   */
  insertFileToContainer: (env: Record<string, string>) => {
    // Check if Google OAuth tokens are present
    if (!env.GOOGLE_OAUTH_TOKEN || !env.GOOGLE_OAUTH_EMAIL) {
      return undefined;
    }

    const email = env.GOOGLE_OAUTH_EMAIL;
    const scopes = [
      'https://www.googleapis.com/auth/chat.spaces',
      'openid',
      'https://www.googleapis.com/auth/tasks.readonly',
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/documents.readonly',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/chat.messages.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/forms.body.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/forms.body',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/forms.responses.readonly',
      'https://www.googleapis.com/auth/presentations.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/cse',
      'https://www.googleapis.com/auth/drive.readonly',
    ];

    // Build the JSON string manually to avoid escaping issues
    const scopesJson = scopes.map((s) => `"${s}"`).join(',');

    // Create wrapper command that:
    // 1. Creates the credentials directory
    // 2. Writes the token to a JSON file with scopes
    // 3. Executes the original command with all arguments
    return {
      wrapperCommand: 'sh',
      wrapperArgs: [
        '-c',
        `mkdir -p ~/.google_workspace_mcp/credentials && ` +
          `echo '{"token": "'$GOOGLE_OAUTH_TOKEN'", "scopes": [${scopesJson}]}' > ~/.google_workspace_mcp/credentials/${email}.json && ` +
          `exec "$@"`,
        'sh', // This becomes $0 in the shell script
      ],
    };
  },
};
