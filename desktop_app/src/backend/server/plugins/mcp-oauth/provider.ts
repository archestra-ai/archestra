/**
 * MCP OAuth Provider Implementation
 *
 * Implements OAuthClientProvider interface from @modelcontextprotocol/sdk/client/auth.js
 */
import {
  OAuthClientProvider,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientInformation, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';

import McpServerModel from '@backend/models/mcpServer';
import { type OAuthServerConfig } from '@backend/schemas/oauth-config';
import log from '@backend/utils/logger';

/**
 * In-memory PKCE code verifier storage (ephemeral, cleared after use)
 * Maps serverId to code verifier for PKCE flow
 */
const codeVerifierStore = new Map<string, string>();

/**
 * In-memory authorization code storage for proxy OAuth flows
 * Maps state to authorization code when using OAuth proxy
 */
export const authCodeStore = new Map<string, string>();

/**
 * Store authorization code from proxy OAuth callback
 */
export function storeAuthorizationCode(state: string, code: string): void {
  log.info(`🔐 Storing authorization code for state: ${state.substring(0, 10)}...`);
  log.info(`🔐 Code (first 20 chars): ${code.substring(0, 20)}...`);
  authCodeStore.set(state, code);
  log.info(`📊 AuthCodeStore size after storage: ${authCodeStore.size}`);
  log.info(
    `🗂️ AuthCodeStore keys: ${Array.from(authCodeStore.keys())
      .map((k) => k.substring(0, 10) + '...')
      .join(', ')}`
  );
}

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
async function discoverScopes(config: OAuthServerConfig): Promise<string[]> {
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
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private config: OAuthServerConfig;
  private serverKey: string;
  public authorizationCode?: string;
  private serverId: string;

  constructor(config: OAuthServerConfig, serverId: string) {
    this.config = config;
    this.serverId = serverId;
    this.serverKey = getServerStorageKey(config.server_url);
  }

  async init(): Promise<void> {
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
    return this.config.redirect_uris[0];
  }

  getServerId(): string {
    return this.serverId;
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
        // Use REDACTED for providers that require oauth-proxy
        ...(this.config.client_secret && {
          client_secret: this.config.requires_proxy ? 'REDACTED' : this.config.client_secret,
        }),
      };
      return clientInfo;
    }

    // Priority 2: Try to load cached dynamic registration from database
    try {
      log.info(`🔍 Looking for cached client info for server ID: ${this.serverId}`);
      const server = await McpServerModel.getById(this.serverId);

      log.info(`📊 Database query result:`, {
        found: !!server?.[0],
        hasOAuthClientInfo: !!server?.[0]?.oauthClientInfo,
        clientInfo: server?.[0]?.oauthClientInfo,
      });

      if (server?.[0]?.oauthClientInfo) {
        log.info('🔑 Using cached dynamic client registration from database');
        const clientInfo = {
          client_id: server[0].oauthClientInfo.client_id,
          ...(server[0].oauthClientInfo.client_secret && { client_secret: server[0].oauthClientInfo.client_secret }),
        };
        log.info('🔑 Loaded client info:', { client_id: clientInfo.client_id, has_secret: !!clientInfo.client_secret });
        return clientInfo;
      }
    } catch (error) {
      log.warn('Failed to load client info from database:', error);
    }

    // Priority 3: Return undefined to trigger dynamic registration
    log.info('🔄 Will use dynamic client registration (no cached client found)');
    return undefined;
  }

  async saveClientInformation(clientInfo: OAuthClientInformation): Promise<void> {
    try {
      log.info('💾 Saving client registration to database for server:', this.serverId);
      log.info('💾 Client info to save:', { client_id: clientInfo.client_id, has_secret: !!clientInfo.client_secret });

      // Save to database instead of local file
      const result = await McpServerModel.update(this.serverId, {
        oauthClientInfo: clientInfo,
      });

      log.info('✅ Client registered and saved to database:', {
        client_id: clientInfo.client_id,
        updated_rows: result.length,
      });
    } catch (error) {
      log.error('❌ Failed to save client information to database:', error);
      throw error;
    }
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    try {
      // Load tokens from database
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

    // Check if using OAuth proxy
    if (this.config.requires_proxy) {
      log.info('📡 Using OAuth proxy - will wait for deep link callback');

      // Extract state from auth URL to wait for callback
      const state = authUrl.searchParams.get('state');
      if (!state) {
        throw new Error('No state parameter in authorization URL');
      }

      // Open browser directly - OAuth proxy will handle callback
      const platform = process.platform;
      const url = authUrl.toString();

      if (platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' });
      } else if (platform === 'win32') {
        spawn('start', [url], { detached: true, stdio: 'ignore', shell: true });
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      }

      log.info('✅ Browser opened - waiting for OAuth proxy callback via deep link');

      // Wait for authorization code to be stored via deep link callback
      try {
        this.authorizationCode = await this.waitForAuthorizationCode(state);
        log.info('✅ Authorization code received via proxy callback');
        return;
      } catch (error) {
        // OAuth flow timed out or failed - clean up the server record
        log.warn(`OAuth flow timed out for server ${this.serverId}, cleaning up...`);

        try {
          await McpServerModel.update(this.serverId, {
            status: 'failed',
            oauthClientInfo: null,
          });
        } catch (cleanupError) {
          log.error('Failed to cleanup server after OAuth timeout:', cleanupError);
        }

        throw error;
      }
    }

    // Original flow for non-proxy OAuth
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
    try {
      this.authorizationCode = await serverPromise;
      log.info('✅ Authorization code captured');
    } catch (error) {
      // OAuth flow timed out or failed - clean up the server record
      log.warn(`OAuth callback server timed out for server ${this.serverId}, cleaning up...`);

      try {
        await McpServerModel.update(this.serverId, {
          status: 'failed',
          oauthClientInfo: null,
        });
      } catch (cleanupError) {
        log.error('Failed to cleanup server after OAuth timeout:', cleanupError);
      }

      throw error;
    }
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
              res.end(`<html><body><h1>❌ OAuth Error</h1></body></html>`);
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

            // Create deeplink to the desktop app (optional fallback)
            const deeplinkUrl = `archestra-ai://oauth-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get('state') || '')}&service=mcp-oauth`;

            const html = `
              <!DOCTYPE html>
              <html>
              <head>
                <title>OAuth Callback</title>
                <meta charset="utf-8">
                <style>
                  body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  }
                  .container {
                    text-align: center;
                    background: white;
                    padding: 40px;
                    border-radius: 10px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                  }
                  h1 { color: #333; }
                  p { color: #666; margin: 20px 0; }
                  a {
                    display: inline-block;
                    padding: 12px 24px;
                    background: #667eea;
                    color: white;
                    text-decoration: none;
                    border-radius: 5px;
                    margin-top: 20px;
                  }
                  a:hover { background: #5a67d8; }
                </style>
              </head>
              <body>
                <div class="container">
                  <h1>Authorization Successful</h1>
                  <p>Redirecting to Archestra...</p>
                  <p>If the app doesn't open automatically, <a id="deeplink">click here</a></p>
                </div>
                <script>
                  // Safely encode the deeplink URL
                  const deeplinkUrl = ${JSON.stringify(deeplinkUrl)};

                  // Set the href attribute safely
                  document.getElementById('deeplink').href = deeplinkUrl;

                  // Try to open the deeplink
                  try {
                    window.location.href = deeplinkUrl;
                  } catch (e) {
                    console.log('Deeplink failed, user can click manually');
                  }

                  // Preserve existing auto-close functionality
                  setTimeout(() => window.close(), 2000);
                </script>
              </body>
              </html>
            `;

            res.end(html);
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
    codeVerifierStore.set(this.serverId, codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = codeVerifierStore.get(this.serverId);
    if (!verifier) {
      throw new Error('No code verifier found for server');
    }
    return verifier;
  }

  /**
   * Wait for authorization code to be received via deep link when using OAuth proxy
   */
  private async waitForAuthorizationCode(state: string): Promise<string> {
    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const pollInterval = 500; // 500ms
    const startTime = Date.now();

    log.info(`🔍 Waiting for authorization code for state: ${state.substring(0, 10)}...`);
    log.info(`📊 Current authCodeStore size: ${authCodeStore.size}`);
    log.info(
      `🗂️ AuthCodeStore keys: ${Array.from(authCodeStore.keys())
        .map((k) => k.substring(0, 10) + '...')
        .join(', ')}`
    );

    while (Date.now() - startTime < maxWaitTime) {
      const code = authCodeStore.get(state);
      if (code) {
        log.info(`✅ Authorization code found for state: ${state.substring(0, 10)}...`);
        // Clean up stored code
        authCodeStore.delete(state);
        return code;
      }

      // Log periodically to show we're still waiting
      const elapsed = Date.now() - startTime;
      if (elapsed % 5000 < pollInterval) {
        // Log every 5 seconds
        log.info(`⏳ Still waiting for authorization code... (${Math.round(elapsed / 1000)}s elapsed)`);
        log.info(`📊 Current authCodeStore size: ${authCodeStore.size}`);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    log.error(`❌ Timeout waiting for authorization code for state: ${state.substring(0, 10)}...`);
    log.error(`📊 Final authCodeStore size: ${authCodeStore.size}`);
    log.error(
      `🗂️ Final AuthCodeStore keys: ${Array.from(authCodeStore.keys())
        .map((k) => k.substring(0, 10) + '...')
        .join(', ')}`
    );
    throw new Error('Timeout waiting for authorization code from OAuth proxy callback');
  }

  async clear(): Promise<void> {
    // Clear in-memory PKCE code verifier
    codeVerifierStore.delete(this.serverId);

    // Clear OAuth data from database
    try {
      await McpServerModel.update(this.serverId, {
        oauthTokens: null,
        oauthClientInfo: null,
        oauthServerMetadata: null,
        oauthResourceMetadata: null,
      });
      log.info('🗑️ Cleared all OAuth data from database and memory');
    } catch (error) {
      log.error('Failed to clear OAuth data from database:', error);
    }
  }
}
