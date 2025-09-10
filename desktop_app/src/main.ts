import * as Sentry from '@sentry/electron/main';
import { config as dotenvConfig } from 'dotenv';
import { BrowserWindow, NativeImage, app, ipcMain, nativeImage, shell } from 'electron';
import started from 'electron-squirrel-startup';
import fs from 'node:fs';
import path from 'node:path';
import { updateElectronApp } from 'update-electron-app';

import ArchestraMcpClient from '@backend/archestraMcp';
import { runDatabaseMigrations } from '@backend/database';
import UserModel from '@backend/models/user';
import { OllamaClient, OllamaServer } from '@backend/ollama';
import McpServerSandboxManager from '@backend/sandbox';
import { startFastifyServer } from '@backend/server';
import log from '@backend/utils/logger';
import WebSocketServer from '@backend/websocket';

import config from './config';
import { setupProviderBrowserAuthHandlers } from './main-browser-auth';

// Load environment variables from .env file
dotenvConfig();

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Ensure app name early (affects menu label on macOS in dev)
try {
  app.setName(config.build.productName);
  process.title = config.build.productName;
} catch {
  // ignore
}

// Register protocol for OAuth callbacks
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('archestra-ai', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('archestra-ai');
}

/**
 * Configure Sentry for error monitoring, logs, session replay, and tracing
 * https://docs.sentry.io/platforms/javascript/guides/electron/#configure
 */
Sentry.init({
  dsn: config.sentry.dsn,
  /**
   * TODO: pull from User.collectTelemetryData..
   */
});

/**
 * Enable automatic updates
 * https://github.com/electron/update-electron-app?tab=readme-ov-file#usage
 */
updateElectronApp({
  repo: `${config.build.github.owner}/${config.build.github.repoName}`,
  updateInterval: config.build.updateInterval,
});

let mainWindow: BrowserWindow | null = null;

// Resolve icon path for both dev and packaged builds
function resolveIconFilename(): string | undefined {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const repoRoot = process.cwd();
  const projectIconsDir = path.join(repoRoot, 'icons');
  const siblingIconsFromBuild = path.join(__dirname, '../../icons');
  const packagedIconsDir = path.join(process.resourcesPath, 'icons');

  const candidates: string[] = isMac ? ['icon.icns', 'icon.png'] : isWin ? ['icon.ico', 'icon.png'] : ['icon.png'];
  const searchDirs = app.isPackaged
    ? [packagedIconsDir, projectIconsDir, siblingIconsFromBuild]
    : [projectIconsDir, siblingIconsFromBuild, packagedIconsDir];

  for (const dir of searchDirs) {
    for (const file of candidates) {
      const full = path.join(dir, file);
      if (fs.existsSync(full)) {
        return full;
      }
    }
  }
  return undefined;
}

// Load an icon path into a NativeImage with PNG fallback in same directory
function loadIconWithFallback(primaryPath: string | undefined): string | NativeImage | undefined {
  if (!primaryPath) return undefined;
  const img = nativeImage.createFromPath(primaryPath);
  if (!img.isEmpty()) return img;
  try {
    const pngPath = path.join(path.dirname(primaryPath), 'icon.png');
    if (fs.existsSync(pngPath)) {
      const pngImg = nativeImage.createFromPath(pngPath);
      if (!pngImg.isEmpty()) return pngImg;
    }
  } catch (err) {
    log.warn('[ICON] Fallback load failed', err);
  }
  return primaryPath; // let Electron attempt raw path
}

function getWindowIcon(): string | NativeImage | undefined {
  return loadIconWithFallback(resolveIconFilename());
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    resizable: true,
    movable: true,
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 36,
    },
    title: config.build.productName,
    icon: getWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Open the DevTools only in development mode
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
};

/**
 * Start the backend server directly in the main process
 *
 * This integrates all the server functionality directly into the main Electron process
 * instead of spawning a separate Node.js process, which avoids ASAR packaging issues.
 */
async function startBackendServer(): Promise<void> {
  log.info('Starting backend server in main process...');

  try {
    await runDatabaseMigrations();
    await UserModel.ensureUserExists();

    // Start WebSocket and Fastify servers first so they're ready for MCP connections
    WebSocketServer.start();
    await startFastifyServer();

    // Connect to the Archestra MCP server after Fastify is running
    try {
      await ArchestraMcpClient.connect();
      log.info('Archestra MCP client connected successfully');
    } catch (error) {
      log.error('Failed to connect Archestra MCP client:', error);
      // Continue anyway - the app can work without Archestra tools
    }

    // Now start the sandbox manager which will connect MCP clients
    McpServerSandboxManager.onSandboxStartupSuccess = () => {
      log.info('Sandbox startup successful');
    };
    McpServerSandboxManager.onSandboxStartupError = (error) => {
      log.error('Sandbox startup error:', error);
    };
    McpServerSandboxManager.start();

    await OllamaServer.startServer();

    /**
     * Ensure that ollama models that're required for various app functionality are available,
     * downloading them if necessary
     */
    await OllamaClient.ensureModelsAvailable();

    log.info('Backend server started successfully in main process');
  } catch (error) {
    log.error('Failed to start backend server:', error);
    throw error;
  }
}

// Set up IPC handlers
ipcMain.handle('open-external', async (_event, url: string) => {
  await shell.openExternal(url);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Set up OAuth callback handler
ipcMain.handle('oauth-callback', async (_event, params: any) => {
  log.info('OAuth callback received:', params);
  // The frontend will handle sending this to the backend
  return { success: true };
});

// Set up provider-based browser authentication handlers
setupProviderBrowserAuthHandlers();

// Handle protocol for OAuth callbacks (Windows/Linux)
const handleProtocol = (url: string) => {
  log.info('Protocol handler called with URL:', url);

  // Parse the OAuth callback URL
  if (url.startsWith('archestra-ai://oauth-callback')) {
    const urlObj = new URL(url);
    const params = Object.fromEntries(urlObj.searchParams.entries());

    // Send to renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth-callback', params);

      // Focus the window
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  }
};

// Handle the protocol on Windows/Linux
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocol(url);
});

// Handle protocol for single instance (Windows/Linux)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Someone tried to run a second instance, we should focus our window instead.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }

    // Handle protocol URL from command line (Windows/Linux)
    const url = commandLine.find((arg) => arg.startsWith('archestra-ai://'));
    if (url) {
      handleProtocol(url);
    }
  });
}

/**
 * This method will be called when Electron has finished
 * initialization and is ready to create browser windows
 * Some APIs can only be used after this event occurs.
 */
app.on('ready', async () => {
  await startBackendServer();
  createWindow();

  // Set Dock icon explicitly for macOS in development (packaged build uses icns automatically)
  if (process.platform === 'darwin') {
    const iconPath = resolveIconFilename();
    if (iconPath && app.dock) {
      try {
        const img = loadIconWithFallback(iconPath);
        if (img) app.dock.setIcon(img as NativeImage | string);
      } catch (err) {
        log.warn('Failed to set macOS dock icon', err);
      }
    }
  }
});

/**
 * Quit when all windows are closed, except on macOS. There, it's common
 * for applications and their menu bar to stay active until the user quits
 * explicitly with Cmd + Q.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  /**
   * On OS X it's common to re-create a window in the app when the
   * dock icon is clicked and there are no other windows open.
   */
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
