import { BrowserWindow } from 'electron';

import UserModel from '@backend/models/user';
import log from '@backend/utils/logger';
import webSocketService from '@backend/websocket';

/**
 * Handle OAuth callback deep links
 */
export async function handleOAuthCallback(params: URLSearchParams, mainWindow: BrowserWindow | null): Promise<void> {
  const code = params.get('code');
  const state = params.get('state');

  if (code && state) {
    log.info('📥 Received OAuth callback with code and state, sending to backend server...');

    // Send authorization code to backend server via HTTP request
    const serverPort = process.env.ARCHESTRA_API_SERVER_PORT || '54587';
    const serverUrl = `http://localhost:${serverPort}/api/oauth/store-code`;

    log.info('🌐 About to send HTTP request to backend server');
    log.info('📍 Target URL:', serverUrl);
    log.info('🔌 Server port:', serverPort);
    log.info('📦 Request body:', JSON.stringify({ state, code }));

    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state, code }),
      });

      log.info('📥 Received response from backend server');
      log.info('📊 Response status:', response.status);
      log.info('📋 Response headers:', Object.fromEntries(response.headers.entries()));

      if (response.ok) {
        const result = await response.json();
        log.info('✅ Successfully sent authorization code to backend server');
        log.info('📨 Backend server response:', result);
      } else {
        const errorText = await response.text();
        log.error('❌ HTTP request failed with status:', response.status);
        log.error('📄 Error response body:', errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    } catch (error) {
      log.error('❌ Failed to send authorization code to backend server');
      log.error('🔍 Error type:', (error as any).constructor.name);
      log.error('📝 Error message:', (error as Error).message);
      log.error('📚 Error stack:', (error as Error).stack);

      if ((error as any).cause) {
        log.error('🔗 Error cause:', (error as any).cause);
      }
    }
  }

  // Send to renderer process
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth-callback', Object.fromEntries(params.entries()));

    // Focus the window
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

/**
 * Handle authentication success deep links
 */
export async function handleAuthSuccess(params: URLSearchParams, mainWindow: BrowserWindow | null): Promise<void> {
  const token = params.get('token');

  if (!token) {
    log.error('No token provided in auth-success deep link');
    return;
  }

  log.info('🔐 Received auth-success deep link with token');

  try {
    // Update the current user's auth token
    const user = await UserModel.patchUser({
      authToken: token,
    });

    log.info('✅ Successfully saved auth token to database');

    // Emit WebSocket message that user has authenticated
    webSocketService.broadcast({
      type: 'user-authenticated',
      payload: {
        userId: user.uniqueId,
        hasToken: true,
      },
    });

    log.info('📤 Broadcasted user-authenticated message via WebSocket');

    // Send to renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth-success', { token });

      // Focus the window
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  } catch (error) {
    log.error('Failed to handle auth-success deep link:', error);
  }
}

/**
 * Main deep link URL handler
 */
export async function handleDeeplinkUrlOpen(url: string, mainWindow: BrowserWindow | null): Promise<void> {
  log.info('Deep link handler called with URL:', url);

  if (!url.startsWith('archestra-ai://')) {
    log.warn('Invalid deep link URL:', url);
    return;
  }

  try {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;

    // Route to appropriate handler based on the path
    if (urlObj.pathname === '//oauth-callback' || urlObj.host === 'oauth-callback') {
      await handleOAuthCallback(params, mainWindow);
    } else if (urlObj.pathname === '//auth-success' || urlObj.host === 'auth-success') {
      await handleAuthSuccess(params, mainWindow);
    } else {
      log.warn('Unknown deep link path:', urlObj.pathname);
    }
  } catch (error) {
    log.error('Failed to parse deep link URL:', error);
  }
}
