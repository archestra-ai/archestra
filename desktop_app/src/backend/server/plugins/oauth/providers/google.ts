import { OAuthProviderDefinition } from '../provider-interface';

export const googleProvider: OAuthProviderDefinition = {
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
};
