import { OAuthProviderDefinition } from '../provider-interface';

export const slackProvider: OAuthProviderDefinition = {
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
    accessToken: 'SLACK_MCP_XOXP_TOKEN',
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
};
