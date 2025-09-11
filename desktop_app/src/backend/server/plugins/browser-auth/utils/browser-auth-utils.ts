/**
 * Browser Authentication Utilities
 *
 * Common utilities for browser-based authentication flows
 */
import { BrowserWindow } from 'electron';

import log from '@backend/utils/logger';

import { BrowserAuthProviderDefinition, BrowserTokenResponse } from '../provider-interface';

/**
 * Token extraction handler configuration
 */
interface TokenExtractionConfig {
  window: BrowserWindow;
  provider: BrowserAuthProviderDefinition;
  getWorkspaceId: () => string | null;
  onSuccess: (tokens: BrowserTokenResponse) => void;
}

/**
 * Set up token extraction handlers for browser authentication
 */
export function setupTokenExtractionHandlers(config: TokenExtractionConfig): void {
  const { window, provider, getWorkspaceId, onSuccess } = config;
  const browserConfig = provider.browserAuthConfig;

  if (!browserConfig) {
    log.error(`[Browser Auth] No browser config for provider ${provider.name}`);
    return;
  }

  // Common token extraction logic
  const attemptTokenExtraction = async (eventType: string) => {
    const url = window.webContents.getURL();
    log.info(`[Browser Auth - ${provider.name}] ${eventType}:`, url);

    try {
      const extractionContext = {
        url,
        workspaceId: getWorkspaceId(),
        provider: provider.name,
      };

      const tokens = await browserConfig.extractTokens({
        webContents: window.webContents,
        session: window.webContents.session,
        context: extractionContext,
      });

      if (tokens) {
        log.info(`[Browser Auth - ${provider.name}] Successfully extracted tokens on ${eventType}`);
        window.close();
        onSuccess(tokens);
      }
    } catch (error) {
      // Token extraction might fail on intermediate pages, which is normal
      log.debug(`[Browser Auth - ${provider.name}] Token extraction attempt on ${eventType} failed:`, error);
    }
  };

  // Extract tokens when page finishes loading
  window.webContents.on('did-finish-load', () => attemptTokenExtraction('page load'));

  // Also listen for navigation within the same page (SPA navigation)
  window.webContents.on('did-navigate-in-page', () => attemptTokenExtraction('in-page navigation'));
}

/**
 * Security settings for browser authentication windows
 */
export const BROWSER_AUTH_WINDOW_CONFIG = {
  width: 1024,
  height: 768,
  webPreferences: {
    // Security settings - keep all security features enabled
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    sandbox: true,
    // Security: Block insecure content
    allowRunningInsecureContent: false,
  },
  // Show standard window chrome for transparency
  autoHideMenuBar: false,
  titleBarStyle: 'default' as const,
  frame: true,
};

/**
 * Get session partition name for provider
 */
export function getProviderSessionPartition(providerName: string): string {
  return `persist:${providerName}-auth`;
}
