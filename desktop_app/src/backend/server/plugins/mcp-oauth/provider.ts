/**
 * MCP OAuth Provider Implementation
 * 
 * Based on GenericMcpOAuthProvider from linear-mcp-oauth-minimal.ts
 * Implements OAuthClientProvider interface from @modelcontextprotocol/sdk/client/auth.js
 */

import {
  OAuthClientProvider,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
  OAuthProtectedResourceMetadata,
  AuthorizationServerMetadata
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import log from '@backend/utils/logger';
import { type ServerConfig } from './configs';

/**
 * Generate server-specific storage key
 */
function getServerStorageKey(serverUrl: string): string {
  const hash = crypto.createHash('sha256').update(serverUrl).digest('hex');
  return hash.substring(0, 16); // Use first 16 characters for readability
}

/**
 * Discover OAuth scopes from MCP server metadata or OAuth endpoint
 */
async function discoverScopes(config: ServerConfig): Promise<string[]> {
  log.info('🔍 Discovering OAuth scopes for server:', config.server_url);

  try {
    // Try resource metadata discovery first if supported by this provider
    if (config.supports_resource_metadata) {
      try {
        const resourceMetadata = await discoverOAuthProtectedResourceMetadata(config.server_url);

        if (resourceMetadata?.scopes_supported && resourceMetadata.scopes_supported.length > 0) {
          log.info('✅ Found resource-specific scopes:', resourceMetadata.scopes_supported);
          return resourceMetadata.scopes_supported;
        }
      } catch (error) {
        log.info('⚠️  Resource metadata discovery failed:', (error as Error).message);
      }
    }

    // Try authorization server metadata discovery
    try {
      const wellKnownUrl = config.well_known_url || `${config.server_url}/.well-known/oauth-authorization-server`;
      const authServerMetadata = await discoverAuthorizationServerMetadata(wellKnownUrl);

      if (authServerMetadata?.scopes_supported && authServerMetadata.scopes_supported.length > 0) {
        log.info('✅ Found authorization server scopes:', authServerMetadata.scopes_supported);
        return authServerMetadata.scopes_supported;
      }
    } catch (error) {
      log.info('⚠️  Authorization server metadata discovery failed:', (error as Error).message);
    }

    log.info('⚠️  No scopes discovered, using configured default scopes');
    return config.default_scopes;

  } catch (error) {
    log.info('⚠️  Failed to discover scopes:', (error as Error).message);
    log.info('⚠️  Using configured default scopes');
    return config.default_scopes;
  }
}

/**
 * MCP OAuth Client Provider for Archestra
 * Based on GenericMcpOAuthProvider from linear-mcp-oauth-minimal.ts
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private storageDir: string;
  private config: ServerConfig;
  private serverKey: string;
  public authorizationCode?: string;
  private serverId: string;

  constructor(config: ServerConfig, serverId: string) {
    this.config = config;
    this.serverId = serverId;
    this.serverKey = getServerStorageKey(config.server_url);
    this.storageDir = path.join(os.homedir(), '.archestra-mcp-oauth', this.serverKey);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });
    log.info('📁 Storage:', this.storageDir);
    log.info('🌐 Server:', this.config.server_url);
    log.info('🔑 Server Key:', this.serverKey);
    log.info('⚙️  Config:', this.config.name);
    log.info('🎯 Using configured scopes:', this.config.scopes.join(', '));
    
    // Try to discover actual scopes from the server
    try {
      const discoveredScopes = await discoverScopes(this.config);
      if (discoveredScopes && discoveredScopes.length > 0) {
        log.info('🔍 Discovered scopes:', discoveredScopes.join(', '));
        // Update config with discovered scopes if they differ from configured ones
        if (JSON.stringify(discoveredScopes.sort()) !== JSON.stringify(this.config.scopes.sort())) {
          this.config.scopes = discoveredScopes;
          log.info('✅ Updated to use discovered scopes');
        }
      }
    } catch (error) {
      log.info('⚠️  Scope discovery failed, using configured scopes:', (error as Error).message);
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
      log.info('🔑 Using static client registration from config');
      const clientInfo: OAuthClientInformation = {
        client_id: this.config.client_id,
        ...(this.config.client_secret && { client_secret: this.config.client_secret }),
      };
      return clientInfo;
    }

    // Priority 2: Try to load cached dynamic registration from database
    try {
      const { default: McpServerModel } = await import('@backend/models/mcpServer');
      const server = await McpServerModel.getById(this.serverId);
      
      if (server?.[0]?.oauthClientInfo) {
        log.info('🔑 Using cached dynamic client registration from database');
        return {
          client_id: server[0].oauthClientInfo.client_id,
          ...(server[0].oauthClientInfo.client_secret && { client_secret: server[0].oauthClientInfo.client_secret }),
        };
      }
    } catch (error) {
      log.warn('Failed to load client info from database:', error);
    }

    // Priority 3: Return undefined to trigger dynamic registration
    log.info('🔄 Will use dynamic client registration');
    return undefined;
  }

  async saveClientInformation(clientInfo: OAuthClientInformation): Promise<void> {
    try {
      // Save to database instead of local file
      const { default: McpServerModel } = await import('@backend/models/mcpServer');
      await McpServerModel.update(this.serverId, {
        oauthClientInfo: clientInfo,
      });
      log.info('✅ Client registered and saved to database:', clientInfo.client_id);
    } catch (error) {
      log.error('Failed to save client information to database:', error);
      throw error;
    }
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    try {
      // Load tokens from database
      const { default: McpServerModel } = await import('@backend/models/mcpServer');
      const server = await McpServerModel.getById(this.serverId);
      
      if (server?.[0]?.oauthTokens) {
        log.info('🎫 Using cached tokens from database');
        return {
          access_token: server[0].oauthTokens.access_token,
          token_type: server[0].oauthTokens.token_type || 'Bearer',
          ...(server[0].oauthTokens.refresh_token && { refresh_token: server[0].oauthTokens.refresh_token }),
          ...(server[0].oauthTokens.expires_in && { expires_in: server[0].oauthTokens.expires_in }),
          ...(server[0].oauthTokens.scope && { scope: server[0].oauthTokens.scope }),
        };
      }
    } catch (error) {
      log.warn('Failed to load tokens from database:', error);
    }
    
    return undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    try {
      // Save tokens to database
      const { default: McpServerModel } = await import('@backend/models/mcpServer');
      await McpServerModel.update(this.serverId, {
        oauthTokens: tokens,
      });
      log.info('✅ Tokens saved to database');
    } catch (error) {
      log.error('Failed to save tokens to database:', error);
      throw error;
    }
  }

  async redirectToAuthorization(authUrl: URL): Promise<void> {
    log.info('🌐 Opening browser for authorization...');
    log.info('🔗 Auth URL:', authUrl.toString());

    // Start callback server first
    log.info('📡 Starting callback server...');
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

    log.info('✅ Browser opened - please complete authorization');
    log.info('⏳ Waiting for callback...');

    // Wait for callback and store the authorization code
    this.authorizationCode = await serverPromise;
    log.info('✅ Authorization code captured');
  }

  private startCallbackServer(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Handle OAuth callback
        if (req.url?.includes('code=') || req.url?.startsWith('/oauth/callback')) {
          log.info('📡 Callback received:', req.url);

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

            log.info('🔐 Authorization code received:', code.substring(0, 20) + '...');

            // Success response
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html><body>
                <h1>✅ Authorization Successful!</h1>
                <p>You can close this window and return to the application.</p>
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
        log.info('📡 Callback server ready on http://localhost:8080');
      });

      server.on('error', (error) => {
        log.error('❌ Server error:', error);
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
    const files = ['verifier.txt'];
    for (const file of files) {
      try {
        await fs.unlink(path.join(this.storageDir, file));
      } catch {
        // File doesn't exist
      }
    }
    
    // Clear OAuth data from database
    try {
      const { default: McpServerModel } = await import('@backend/models/mcpServer');
      await McpServerModel.update(this.serverId, {
        oauthTokens: null,
        oauthClientInfo: null,
        oauthServerMetadata: null,
        oauthResourceMetadata: null,
      });
      log.info('🗑️ Cleared all OAuth data from database');
    } catch (error) {
      log.error('Failed to clear OAuth data from database:', error);
    }
  }
}