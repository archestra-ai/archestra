/**
 * Generic Browser Authentication Handler
 *
 * This module provides a flexible browser-based authentication system
 * that works with any OAuth provider through configuration.
 */
import { BrowserWindow, ipcMain } from 'electron';

import {
  BrowserAuthProviderDefinition,
  BrowserTokenResponse,
} from './backend/server/plugins/browser-auth/provider-interface';
import {
  getBrowserAuthProvider,
  hasBrowserAuthProvider,
} from './backend/server/plugins/browser-auth/provider-registry';
import {
  BROWSER_AUTH_WINDOW_CONFIG,
  getProviderSessionPartition,
  setupTokenExtractionHandlers,
} from './backend/server/plugins/browser-auth/utils/browser-auth-utils';
import log from './backend/utils/logger';

/**
 * Set up browser authentication handlers for all configured providers
 */
export function setupProviderBrowserAuthHandlers() {
  // Register IPC handler for provider browser auth
  ipcMain.handle('provider-browser-auth', async (_event, providerName: string) => {
    if (!hasBrowserAuthProvider(providerName)) {
      throw new Error(`Provider ${providerName} not configured`);
    }

    const provider = getBrowserAuthProvider(providerName);

    if (!provider.browserAuthConfig?.enabled) {
      throw new Error(`Browser auth not enabled for provider ${providerName}`);
    }

    return handleBrowserAuth(provider);
  });

  log.info('[Browser Auth] Provider browser auth handlers registered');
}

/**
 * Convert BrowserTokenResponse to OAuth-like format for UI compatibility
 */
function convertBrowserTokensToOAuthFormat(tokens: BrowserTokenResponse, provider: BrowserAuthProviderDefinition): any {
  // Map browser tokens to OAuth format based on provider config
  if (provider.browserAuthConfig?.tokenMapping) {
    return {
      access_token: tokens.primary_token,
      refresh_token: tokens.secondary_token || null,
      // Browser tokens typically don't expire
      expires_at: null,
    };
  }

  // Default mapping
  return {
    access_token: tokens.primary_token,
    refresh_token: tokens.secondary_token || null,
    expires_at: null,
  };
}

/**
 * Handle browser-based authentication for a provider
 */
async function handleBrowserAuth(provider: BrowserAuthProviderDefinition): Promise<any> {
  return new Promise((resolve, reject) => {
    let authWindow: BrowserWindow | null = null;
    let detectedWorkspaceId: string | null = null;

    const config = provider.browserAuthConfig;
    if (!config) {
      reject(new Error(`No browser auth config for provider ${provider.name}`));
      return;
    }

    try {
      // Create a secure browser window for authentication
      authWindow = new BrowserWindow({
        ...BROWSER_AUTH_WINDOW_CONFIG,
        webPreferences: {
          ...BROWSER_AUTH_WINDOW_CONFIG.webPreferences,
          // Use a separate session for authentication
          partition: getProviderSessionPartition(provider.name),
        },
      });

      // Setup navigation handlers
      setupNavigationHandlers(authWindow, provider, (workspaceId) => {
        detectedWorkspaceId = workspaceId;
      });

      // Setup token extraction with simplified handlers
      setupTokenExtractionHandlers({
        window: authWindow,
        provider,
        getWorkspaceId: () => detectedWorkspaceId,
        onSuccess: (tokens) => {
          const oauthTokens = convertBrowserTokensToOAuthFormat(tokens, provider);
          resolve(oauthTokens);
        },
      });

      // Handle window closed
      authWindow.on('closed', () => {
        authWindow = null;
        reject(new Error('Authentication window was closed by user'));
      });

      // Load the login page
      authWindow.loadURL(config.loginUrl);
    } catch (error) {
      log.error(`[Browser Auth] Error creating auth window for ${provider.name}:`, error);
      if (authWindow) {
        authWindow.close();
      }
      reject(error);
    }
  });
}

/**
 * Set up navigation handlers for the authentication window
 */
function setupNavigationHandlers(
  authWindow: BrowserWindow,
  provider: BrowserAuthProviderDefinition,
  onWorkspaceDetected: (workspaceId: string) => void
) {
  const config = provider.browserAuthConfig;
  if (!config) return;

  // Show URL in title for transparency
  authWindow.webContents.on('page-title-updated', (_event, title) => {
    const url = authWindow.webContents.getURL();
    // Only show provider domains in title for security
    if (config.navigationRules ? config.navigationRules(url) : true) {
      authWindow.setTitle(`${title} - ${url}`);
    }
  });

  // Security: Restrict navigation based on provider rules
  authWindow.webContents.on('will-navigate', (event, url) => {
    log.info(`[Browser Auth - ${provider.name}] Navigation attempt to:`, url);

    // Handle provider-specific protocols (e.g., slack://)
    if (config.workspacePattern) {
      const match = url.match(config.workspacePattern);
      if (match && match[1]) {
        event.preventDefault();
        onWorkspaceDetected(match[1]);
        log.info(`[Browser Auth - ${provider.name}] Detected workspace ID:`, match[1]);

        // Navigate to web version if needed
        if (provider.name === 'slack-browser') {
          const webUrl = `https://app.slack.com/client/${match[1]}`;
          authWindow.loadURL(webUrl);
        }
        return;
      }
    }

    // Apply navigation rules
    if (config.navigationRules) {
      const isAllowed = config.navigationRules(url);
      if (!isAllowed) {
        log.warn(`[Browser Auth - ${provider.name}] Blocked navigation to:`, url);
        event.preventDefault();
      }
    }
  });

  // Handle new window requests
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    log.info(`[Browser Auth - ${provider.name}] New window request:`, url);

    // If it's an allowed URL, navigate in the same window
    if (config.navigationRules ? config.navigationRules(url) : true) {
      log.info(`[Browser Auth - ${provider.name}] Navigating to:`, url);
      authWindow.loadURL(url);
    }

    // Deny opening a new window
    return { action: 'deny' };
  });
}

/**
 * Helper function to show messages in the browser window
 */
export async function showBrowserMessage(
  window: BrowserWindow,
  message: string,
  type: 'info' | 'error' | 'success' = 'info'
) {
  const backgroundColor = type === 'error' ? '#E01E5A' : type === 'success' ? '#2eb67d' : '#4A154B';

  await window.webContents.executeJavaScript(`
    const existingMessage = document.getElementById('archestra-message');
    if (!existingMessage) {
      const messageDiv = document.createElement('div');
      messageDiv.id = 'archestra-message';
      messageDiv.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: ${backgroundColor}; color: white; padding: 15px 20px; border-radius: 8px; z-index: 10000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);';
      messageDiv.innerHTML = '<strong>Archestra:</strong> ' + ${JSON.stringify(message)};
      document.body.appendChild(messageDiv);
    } else {
      existingMessage.style.background = '${backgroundColor}';
      existingMessage.innerHTML = '<strong>Archestra:</strong> ' + ${JSON.stringify(message)};
    }
  `);
}
