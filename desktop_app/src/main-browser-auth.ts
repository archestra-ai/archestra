/**
 * Generic Browser Authentication Handler
 *
 * TODO: This entire module needs to be reimplemented with the new MCP OAuth system
 * The old OAuth system has been replaced with MCP SDK-based OAuth
 */
import { ipcMain } from 'electron';

import log from './backend/utils/logger';

/**
 * Set up browser authentication handlers for all configured providers
 */
export function setupProviderBrowserAuthHandlers() {
  // TODO: Migrate to new MCP OAuth system
  // Browser auth functionality needs to be reimplemented with MCP OAuth
  log.info('[Browser Auth] Provider browser auth handlers disabled - awaiting MCP OAuth migration');

  // Temporary stub handlers to prevent crashes
  ipcMain.handle('provider-browser-auth', async (_event, providerName: string) => {
    throw new Error(`Browser auth for ${providerName} not yet implemented in MCP OAuth system`);
  });

  ipcMain.handle('slack-auth', async () => {
    throw new Error('Slack browser auth not yet implemented in MCP OAuth system');
  });
}
