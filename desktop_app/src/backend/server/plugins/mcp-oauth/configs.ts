/**
 * MCP OAuth Server Configurations
 *
 * Based on SERVER_CONFIGS from linear-mcp-oauth-minimal.ts
 * Defines OAuth provider configurations for MCP servers
 */

// Debug logging for environment variables
console.log('🔍 Environment variables debug:', {
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? '***PRESENT***' : 'MISSING',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ? '***PRESENT***' : 'MISSING',
  SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET ? '***PRESENT***' : 'MISSING',
  OAUTH_PROXY_URL: process.env.OAUTH_PROXY_URL || 'MISSING',
  NODE_ENV: process.env.NODE_ENV,
  processTitle: process.title,
  cwd: process.cwd(),
});

/**
 * Server configuration interface
 */
export interface ServerConfig {
  name: string;
  server_url: string;
  auth_server_url?: string; // Optional, defaults to server_url
  resource_metadata_url?: string;
  client_id: string;
  client_secret?: string; // Optional for public clients
  redirect_uris: string[];
  scopes: string[];
  description?: string;
  well_known_url?: string; // Optional specific well-known URL for this provider
  default_scopes: string[]; // Fallback scopes when discovery fails
  supports_resource_metadata: boolean; // Whether to attempt resource metadata discovery
}

/**
 * Predefined server configurations for common OAuth providers
 */
export const SERVER_CONFIGS: Record<string, ServerConfig> = {
  google: {
    name: 'Google OAuth',
    server_url: 'https://accounts.google.com',
    resource_metadata_url: 'https://accounts.google.com/.well-known/openid-configuration',
    client_id: '354887056155-5b4rlcofccknibd4fv3ldud9vvac3rdf.apps.googleusercontent.com',
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uris: ['http://localhost:8080/oauth/callback'],
    scopes: ['openid', 'email', 'profile'],
    description: 'Google OAuth (OpenID Connect)',
    well_known_url: 'https://accounts.google.com/.well-known/openid-configuration',
    default_scopes: ['openid', 'email', 'profile'],
    supports_resource_metadata: false,
  },
  github: {
    name: 'GitHub Copilot MCP',
    server_url: 'https://api.githubcopilot.com/mcp/',
    client_id: 'Ov23li3CnHLM7PNQ2Xiv',
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    redirect_uris: ['http://localhost:8080/oauth/callback'],
    scopes: ['read', 'write'],
    description: 'GitHub Copilot MCP Server',
    default_scopes: ['read', 'write'],
    supports_resource_metadata: true,
  },
  linear: {
    name: 'Linear MCP',
    server_url: 'https://mcp.linear.app/mcp',
    client_id: '', // Will use dynamic registration
    redirect_uris: ['http://localhost:8080/oauth/callback'],
    scopes: ['read', 'write'],
    description: 'Linear MCP Server (dynamic registration)',
    default_scopes: ['read', 'write'],
    supports_resource_metadata: true,
  },
  slack: {
    name: 'Slack MCP',
    server_url: 'https://slack.com/oauth/v2/',
    well_known_url: 'https://slack.com/.well-known/openid-configuration',
    client_id: process.env.SLACK_CLIENT_ID || '',
    client_secret: process.env.SLACK_CLIENT_SECRET || '',
    redirect_uris: ['http://localhost:8080/oauth/callback'],
    scopes: ['channels:read', 'chat:write', 'users:read'],
    description: 'Slack MCP Server',
    default_scopes: ['channels:read', 'chat:write', 'users:read'],
    supports_resource_metadata: false,
  },
};

/**
 * Get server configuration by provider name
 */
export function getServerConfig(provider: string): ServerConfig | undefined {
  return SERVER_CONFIGS[provider];
}

/**
 * Get all available provider names
 */
export function getAvailableProviders(): string[] {
  return Object.keys(SERVER_CONFIGS);
}

/**
 * Show available server configurations
 */
export function showAvailableServers(): void {
  console.log('\nAvailable MCP OAuth Servers:');
  Object.entries(SERVER_CONFIGS).forEach(([key, config]) => {
    console.log(`  ${key.padEnd(12)} - ${config.description || config.name}`);
  });
  console.log('');
}

/**
 * Validate server configuration
 */
export function validateServerConfig(config: ServerConfig): void {
  if (!config.name) {
    throw new Error('Server configuration must have a name');
  }
  if (!config.server_url) {
    throw new Error('Server configuration must have a server_url');
  }
  if (!config.redirect_uris || config.redirect_uris.length === 0) {
    throw new Error('Server configuration must have at least one redirect_uri');
  }
  if (!config.scopes || config.scopes.length === 0) {
    throw new Error('Server configuration must have at least one scope');
  }
  if (!config.default_scopes || config.default_scopes.length === 0) {
    throw new Error('Server configuration must have at least one default scope');
  }
}
