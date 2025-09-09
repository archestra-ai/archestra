#!/usr/bin/env tsx
/**
 * Generic MCP OAuth Client - Based on MCP Inspector
 * Simple implementation using the MCP SDK's built-in auth functionality
 * Supports any MCP server with OAuth metadata discovery
 * Experimantal - TODO: Remove after refactoring completed
 */
// Load environment variables from .env file
import {
  OAuthClientProvider,
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AuthorizationServerMetadata,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { config } from 'dotenv';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

config();

/**
 * Server configuration interface
 */
interface ServerConfig {
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
 * Predefined server configurations
 */
const SERVER_CONFIGS: Record<string, ServerConfig> = {
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
    // server_url: 'https://github.com/login/oauth/',
    // auth_server_url: 'https://github.com/login/oauth/',
    // resource_metadata_url: 'https://github.com/login/oauth/.well-known/openid-configuration',
    // well_known_url: 'https://github.com/login/oauth/.well-known/openid-configuration',
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
  huggingface: {
    name: 'HuggingFace MCP',
    server_url: 'https://huggingface.co/mcp',
    client_id: '', // Will use dynamic registration
    redirect_uris: ['http://localhost:8080/oauth/callback'],
    scopes: ['read', 'write'],
    description: 'HF MCP Server (dynamic registration)',
    default_scopes: ['read', 'write'],
    supports_resource_metadata: true,
  },
  slack: {
    name: 'Slack OAuth',
    server_url: 'https://slack.com',
    auth_server_url: 'https://slack.com',
    client_id: process.env.SLACK_CLIENT_ID || '',
    client_secret: process.env.SLACK_CLIENT_SECRET,
    redirect_uris: ['http://localhost:8080/oauth/callback'],
    scopes: ['channels:read', 'chat:write', 'users:read'],
    description: 'Slack OAuth Integration',
    default_scopes: ['channels:read', 'chat:write', 'users:read'],
    supports_resource_metadata: false,
  },
};

/**
 * Discover OAuth scopes from MCP server metadata or OAuth endpoint
 */
async function discoverScopes(config: ServerConfig): Promise<string[]> {
  console.log('🔍 Discovering OAuth scopes for server:', config.server_url);

  try {
    // Try resource metadata discovery first if supported by this provider
    if (config.supports_resource_metadata) {
      try {
        const resourceMetadata = await discoverOAuthProtectedResourceMetadata(config.server_url);

        if (resourceMetadata?.scopes_supported && resourceMetadata.scopes_supported.length > 0) {
          console.log('✅ Found resource-specific scopes:', resourceMetadata.scopes_supported);
          return resourceMetadata.scopes_supported;
        }
      } catch (error) {
        console.log('⚠️  Resource metadata discovery failed:', (error as Error).message);
      }
    }

    // Try authorization server metadata discovery
    try {
      const wellKnownUrl =
        config.well_known_url ||
        `${config.auth_server_url || config.server_url}/.well-known/oauth-authorization-server`;
      console.log('🔍 Trying authorization server metadata at:', wellKnownUrl);
      const authServerMetadata = await discoverAuthorizationServerMetadata(wellKnownUrl);

      console.log('🔍 Authorization server metadata:', {
        issuer: authServerMetadata?.issuer,
        authorization_endpoint: authServerMetadata?.authorization_endpoint,
        token_endpoint: authServerMetadata?.token_endpoint,
        scopes_supported: authServerMetadata?.scopes_supported,
      });

      if (authServerMetadata?.scopes_supported && authServerMetadata.scopes_supported.length > 0) {
        console.log('✅ Found authorization server scopes:', authServerMetadata.scopes_supported);
        return authServerMetadata.scopes_supported;
      }
    } catch (error) {
      console.log('⚠️  Authorization server metadata discovery failed:', (error as Error).message);
    }

    console.log('⚠️  No scopes discovered, using configured default scopes');
    return config.default_scopes;
  } catch (error) {
    console.log('⚠️  Failed to discover scopes:', (error as Error).message);
    console.log('⚠️  Using configured default scopes');
    return config.default_scopes;
  }
}

/**
 * Generate server-specific storage key - Based on Inspector pattern
 */
function getServerStorageKey(serverUrl: string): string {
  const hash = crypto.createHash('sha256').update(serverUrl).digest('hex');
  return hash.substring(0, 16); // Use first 16 characters for readability
}

/**
 * Simple OAuth Client Provider for MCP Servers - Based on MCP Inspector pattern
 */
class GenericMcpOAuthProvider implements OAuthClientProvider {
  private storageDir: string;
  private config: ServerConfig;
  private serverKey: string;
  public authorizationCode?: string;

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverKey = getServerStorageKey(config.server_url);
    this.storageDir = path.join(os.homedir(), '.mcp-oauth', this.serverKey);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });
    console.log('📁 Storage:', this.storageDir);
    console.log('🌐 Server:', this.config.server_url);
    console.log('🔑 Server Key:', this.serverKey);
    console.log('⚙️  Config:', this.config.name);
    console.log('🎯 Using configured scopes:', this.config.scopes.join(', '));

    // Try to discover actual scopes from the server
    try {
      const discoveredScopes = await discoverScopes(this.config);
      if (discoveredScopes && discoveredScopes.length > 0) {
        console.log('🔍 Discovered scopes:', discoveredScopes.join(', '));
        // Update config with discovered scopes if they differ from configured ones
        if (JSON.stringify(discoveredScopes.sort()) !== JSON.stringify(this.config.scopes.sort())) {
          this.config.scopes = discoveredScopes;
          console.log('✅ Updated to use discovered scopes');
        }
      }
    } catch (error) {
      console.log('⚠️  Scope discovery failed, using configured scopes:', (error as Error).message);
    }
  }

  get redirectUrl(): string {
    return 'http://localhost:8080/oauth/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.name,
      redirect_uris: this.config.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.client_secret ? 'client_secret_post' : 'none', // Use secret if available, otherwise PKCE
      scope: this.config.scopes.join(' '),
    };
  }

  get scopes(): string[] {
    return this.config.scopes;
  }

  state(): string {
    return crypto.randomBytes(16).toString('base64url');
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Priority 1: If config has client_id, use static registration
    if (this.config.client_id && this.config.client_id !== '') {
      console.log('🔑 Using static client registration from config');
      const clientInfo: OAuthClientInformation = {
        client_id: this.config.client_id,
        ...(this.config.client_secret && { client_secret: this.config.client_secret }),
      };
      return clientInfo;
    }

    // Priority 2: Try to load cached dynamic registration
    try {
      const data = await fs.readFile(path.join(this.storageDir, 'client.json'), 'utf-8');
      console.log('🔑 Using cached dynamic client registration');
      return JSON.parse(data);
    } catch {
      // Priority 3: Return undefined to trigger dynamic registration
      console.log('🔄 Will use dynamic client registration');
      return undefined;
    }
  }

  async saveClientInformation(clientInfo: OAuthClientInformation): Promise<void> {
    await fs.writeFile(path.join(this.storageDir, 'client.json'), JSON.stringify(clientInfo, null, 2));
    console.log('✅ Client registered:', clientInfo.client_id);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    try {
      const data = await fs.readFile(path.join(this.storageDir, 'tokens.json'), 'utf-8');
      const parsedTokens = JSON.parse(data);
      console.log('🎫 Using cached tokens:', {
        hasAccessToken: !!parsedTokens.access_token,
        tokenType: parsedTokens.token_type,
        hasRefreshToken: !!parsedTokens.refresh_token,
        expiresIn: parsedTokens.expires_in,
        scope: parsedTokens.scope,
      });
      return parsedTokens;
    } catch (error) {
      console.log('🔍 No cached tokens found:', (error as Error).message);
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    console.log('💾 Saving tokens:', {
      hasAccessToken: !!tokens.access_token,
      tokenType: tokens.token_type,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    });
    await fs.writeFile(path.join(this.storageDir, 'tokens.json'), JSON.stringify(tokens, null, 2));
    console.log('✅ Tokens saved');
  }

  async redirectToAuthorization(authUrl: URL): Promise<void> {
    console.log('🌐 Opening browser for authorization...');
    console.log('🔗 Auth URL:', authUrl.toString());

    // Start callback server first
    console.log('📡 Starting callback server...');
    const serverPromise = this.startCallbackServer();

    // Open browser
    const platform = process.platform;
    const url = authUrl.toString();

    if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else if (platform === 'win32') {
      spawn('start', [url], { detached: true, stdio: 'ignore', shell: true });
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }

    console.log('✅ Browser opened - please complete authorization');
    console.log('⏳ Waiting for callback...');

    // Wait for callback and store the authorization code
    this.authorizationCode = await serverPromise;
    console.log('✅ Authorization code captured');
  }

  private startCallbackServer(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Handle OAuth callback
        if (req.url?.includes('code=') || req.url?.startsWith('/oauth/callback')) {
          console.log('📡 Callback received:', req.url);

          try {
            const url = new URL(req.url, 'http://localhost:8080');
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`<html><body><h1>❌ OAuth Error</h1><p>${error}</p></body></html>`);
              server.close();
              reject(new Error(`OAuth error: ${error}`));
              return;
            }

            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>❌ No Authorization Code</h1></body></html>');
              server.close();
              reject(new Error('No authorization code received'));
              return;
            }

            console.log('🔐 Authorization code received:', code.substring(0, 20) + '...');

            // Success response
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html><body>
                <h1>✅ Authorization Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
                <script>setTimeout(() => window.close(), 2000);</script>
              </body></html>
            `);
            server.close();
            resolve(code);
          } catch (parseError) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>❌ Server Error</h1></body></html>');
            server.close();
            reject(parseError);
          }
        } else {
          // Handle unexpected requests
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>OAuth Callback Server</h1><p>Waiting for authorization...</p></body></html>');
        }
      });

      server.listen(8080, () => {
        console.log('📡 Callback server ready on http://localhost:8080');
      });

      server.on('error', (error) => {
        console.log('❌ Server error:', error);
        reject(error);
      });

      // Timeout after 5 minutes
      setTimeout(
        () => {
          server.close();
          reject(new Error('Authorization timeout - no callback received within 5 minutes'));
        },
        5 * 60 * 1000
      );
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await fs.writeFile(path.join(this.storageDir, 'verifier.txt'), codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const data = await fs.readFile(path.join(this.storageDir, 'verifier.txt'), 'utf-8');
    return data;
  }

  async clear(): Promise<void> {
    const files = ['client.json', 'tokens.json', 'verifier.txt'];
    for (const file of files) {
      try {
        await fs.unlink(path.join(this.storageDir, file));
      } catch {
        // File doesn't exist
      }
    }
    console.log('🗑️ Cleared all OAuth data');
  }
}

/**
 * Intercept fetch to log GitHub token requests/responses
 */
function interceptFetch() {
  const originalFetch = global.fetch;
  global.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    // Log token endpoint requests
    if (urlString.includes('token') || urlString.includes('github.com') || urlString.includes('oauth')) {
      console.log('🌐 HTTP Request:', {
        url: urlString,
        method: options?.method || 'GET',
        headers: options?.headers,
        body: options?.body,
      });
    }

    const response = await originalFetch(url, options);

    // Log token endpoint responses
    if (urlString.includes('token') || urlString.includes('github.com') || urlString.includes('oauth')) {
      const responseClone = response.clone();
      const responseText = await responseClone.text();

      console.log('🌐 HTTP Response:', {
        url: urlString,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseText,
      });
    }

    return response;
  };
}

/**
 * Handle OAuth authentication flow
 */
async function performOAuth(provider: GenericMcpOAuthProvider, config: ServerConfig): Promise<string> {
  console.log('🔐 Starting OAuth with MCP SDK...');

  // Intercept fetch to log GitHub responses
  interceptFetch();

  // First attempt: try with existing tokens
  console.log('🔍 Attempting initial auth with config:', {
    serverUrl: config.server_url,
    scope: config.scopes.join(' '),
    hasResourceMetadataUrl: !!config.resource_metadata_url,
  });

  let authResult = await auth(provider, {
    serverUrl: config.server_url,
    scope: config.scopes.join(' '),
    resourceMetadataUrl: config.resource_metadata_url ? new URL(config.resource_metadata_url) : undefined,
  });

  console.log('✅ OAuth result (initial):', authResult);

  // If we need to redirect, handle the OAuth flow with authorization code
  if (authResult === 'REDIRECT') {
    console.log('🔄 OAuth requires authorization - authorization code will be captured automatically');

    // Wait a moment for the browser flow to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Now try with the captured authorization code
    if (provider.authorizationCode) {
      console.log('🔐 Using captured authorization code for token exchange...');
      console.log('🔍 Token exchange config:', {
        serverUrl: config.server_url,
        scope: config.scopes.join(' '),
        authorizationCode: provider.authorizationCode.substring(0, 20) + '...',
        hasResourceMetadataUrl: !!config.resource_metadata_url,
        authServerUrl: config.auth_server_url,
      });

      try {
        authResult = await auth(provider, {
          serverUrl: config.server_url,
          scope: config.scopes.join(' '),
          authorizationCode: provider.authorizationCode,
          resourceMetadataUrl: config.resource_metadata_url ? new URL(config.resource_metadata_url) : undefined,
        });

        console.log('✅ OAuth result (with code):', authResult);
      } catch (error) {
        console.log('❌ Auth function threw error:', error);
        console.log('❌ Error details:', JSON.stringify(error, null, 2));
        throw error;
      }
    } else {
      throw new Error('No authorization code captured');
    }
  }

  if (authResult !== 'AUTHORIZED') {
    throw new Error(`OAuth not authorized: ${authResult}`);
  }

  // Get the actual access token from the provider after successful auth
  const tokens = await provider.tokens();
  if (!tokens || !tokens.access_token) {
    throw new Error('No access token found after OAuth');
  }

  console.log('✅ OAuth completed! Token:', tokens.access_token.substring(0, 30) + '...');
  return tokens.access_token;
}

/**
 * Simple OAuth + MCP connection function
 */
async function connectMcpServer(config: ServerConfig) {
  const provider = new GenericMcpOAuthProvider(config);
  await provider.init();

  try {
    // Perform OAuth authentication
    const accessToken = await performOAuth(provider, config);

    // Test MCP connection
    console.log('🔌 Testing MCP connection...');
    const transport = new StreamableHTTPClientTransport(new URL(config.server_url), {
      requestInit: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    });

    const client = new Client({ name: 'linear-mcp-minimal', version: '1.0.0' }, { capabilities: { sampling: {} } });

    await client.connect(transport);
    console.log('✅ MCP connected!');

    const tools = await client.listTools();
    console.log(`🛠️  Found ${tools.tools.length} tools:`);
    tools.tools.forEach((tool, i) => {
      console.log(`   ${i + 1}. ${tool.name}: ${tool.description}`);
    });

    await client.close();
    console.log('👋 Done!');
  } catch (error) {
    console.error('❌ Error:', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Show available server configurations
 */
function showAvailableServers() {
  console.log('\nAvailable Servers:');
  Object.entries(SERVER_CONFIGS).forEach(([key, config]) => {
    console.log(`  ${key.padEnd(8)} - ${config.description || config.name}`);
  });
  console.log('');
}

/**
 * CLI
 */
async function main() {
  const args = process.argv.slice(2);

  // Handle --help first
  if (args.includes('--help')) {
    console.log(`
Generic MCP OAuth Client

Usage:
  tsx linear-mcp-oauth-minimal.ts --server <name> [options]

Options:
  --server <name>      REQUIRED - Select server from available configurations
  --list-servers       Show available server configurations
  --auth-only          Run OAuth only (no MCP test)
  --clear              Clear cached data for selected server
  --help               Show help

Available Servers:`);

    Object.entries(SERVER_CONFIGS).forEach(([key, config]) => {
      console.log(`  ${key.padEnd(8)} - ${config.description || config.name}`);
    });

    console.log(`
Examples:
  tsx linear-mcp-oauth-minimal.ts --server google --auth-only    # Google OAuth test
  tsx linear-mcp-oauth-minimal.ts --server github               # GitHub MCP connection
  tsx linear-mcp-oauth-minimal.ts --server linear               # Linear MCP connection
  tsx linear-mcp-oauth-minimal.ts --list-servers                # Show all available servers
  tsx linear-mcp-oauth-minimal.ts --server google --clear       # Clear Google OAuth cache
`);
    return;
  }

  // Handle --list-servers
  if (args.includes('--list-servers')) {
    showAvailableServers();
    return;
  }

  // Parse server selection (REQUIRED)
  const serverIndex = args.indexOf('--server');
  if (serverIndex === -1 || !args[serverIndex + 1]) {
    console.error('❌ Error: --server parameter is required');
    console.log('\nUsage: tsx linear-mcp-oauth-minimal.ts --server <name> [options]');
    showAvailableServers();
    console.log('Use --help for more information');
    process.exit(1);
  }

  const serverName = args[serverIndex + 1];
  const config = SERVER_CONFIGS[serverName];
  if (!config) {
    console.error(`❌ Error: Unknown server '${serverName}'`);
    showAvailableServers();
    console.log('Use --list-servers to see available servers');
    process.exit(1);
  }

  console.log(`🎯 Using server: ${config.name}`);

  const provider = new GenericMcpOAuthProvider(config);

  if (args.includes('--clear')) {
    await provider.init();
    await provider.clear();
    return;
  }

  if (args.includes('--auth-only')) {
    await provider.init();
    try {
      const accessToken = await performOAuth(provider, config);
      console.log('✅ OAuth only completed! Token:', accessToken.substring(0, 30) + '...');
    } catch (error) {
      console.error('❌ OAuth failed:', (error as Error).message);
    }
    return;
  }

  await connectMcpServer(config);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { GenericMcpOAuthProvider, connectMcpServer };
