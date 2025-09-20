import { config as dotenvConfig } from 'dotenv';
import { BrowserWindow, NativeImage, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import { REACT_DEVELOPER_TOOLS, installExtension } from 'electron-devtools-installer';
import started from 'electron-squirrel-startup';
import fs from 'node:fs';
import path from 'node:path';
import { updateElectronApp } from 'update-electron-app';

import ArchestraMcpClient from '@backend/clients/archestraMcp';
import ollamaClient from '@backend/clients/ollama';
import { runDatabaseMigrations } from '@backend/database';
import UserModel from '@backend/models/user';
import ollamaServer from '@backend/ollamaServer';
import McpServerSandboxManager from '@backend/sandbox';
import { startFastifyServer, stopFastifyServer } from '@backend/server';
import log from '@backend/utils/logger';
import sentryClient from '@backend/utils/sentry';
import WebSocketServer from '@backend/websocket';

import config from './config';
import { setupProviderBrowserAuthHandlers } from './main-browser-auth';

// Load environment variables from .env file
dotenvConfig();

/**
 * Initialize Sentry early for error tracking
 *
 * Don't initialize Sentry when running in codegen mode as it leads to some issues
 * with the code generation process.
 */
if (!process.env.CODEGEN) {
  sentryClient.initialize();
}

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
 * Enable automatic updates
 * https://github.com/electron/update-electron-app?tab=readme-ov-file#usage
 */
updateElectronApp({
  repo: `${config.build.github.owner}/${config.build.github.repoName}`,
  updateInterval: config.build.updateInterval,
  logger: log,
});

let mainWindow: BrowserWindow | null = null;
let isCleaningUp = false;

/**
 * Cleanup function to gracefully shut down all backend services
 */
async function cleanup(): Promise<void> {
  if (isCleaningUp) {
    return; // Prevent multiple cleanup attempts
  }

  isCleaningUp = true;
  log.info('Starting graceful shutdown cleanup...');

  try {
    // Stop Fastify server first to prevent new requests
    await stopFastifyServer();
  } catch (error) {
    log.error('Error stopping Fastify server:', error);
  }

  try {
    // Stop WebSocket server
    WebSocketServer.stop();
  } catch (error) {
    log.error('Error stopping WebSocket server:', error);
  }

  try {
    // Disconnect from Archestra MCP server
    await ArchestraMcpClient.disconnect();
  } catch (error) {
    log.error('Error disconnecting Archestra MCP client:', error);
  }

  try {
    // Turn off sandbox manager (stops all MCP containers)
    McpServerSandboxManager.turnOffSandbox();
  } catch (error) {
    log.error('Error turning off sandbox:', error);
  }

  try {
    // Stop Ollama server
    await ollamaServer.stopServer();
  } catch (error) {
    log.error('Error stopping Ollama server:', error);
  }

  log.info('Graceful shutdown cleanup completed');
}

// Resolve icon path for both dev and packaged builds
function resolveIconFilename(): string | undefined {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const repoRoot = process.cwd();
  const projectIconsDir = path.join(repoRoot, 'assets', 'icons');
  const siblingIconsFromBuild = path.join(__dirname, '../../assets', 'icons');
  const packagedIconsDir = path.join(process.resourcesPath, 'assets', 'icons');

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

const createWindow = async () => {
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
      /**
       * NOTE: for now we'll just keep devtools enabled while we're in alpha stage
       *
       * later on we should probably disable this for packaged buidls (ie. `devTools: !app.isPackaged`)
       */
      devTools: true,
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
    // note that Components and Profiler tabs start to appear after first reload
    // https://github.com/electron/electron/issues/41613
    await installExtension(REACT_DEVELOPER_TOOLS);
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
    const user = await UserModel.ensureUserExists();

    // Set Sentry user context now that user is available
    sentryClient.setUserContext(user);

    // Start WebSocket and Fastify servers first so they're ready for MCP connections
    WebSocketServer.start();
    await startFastifyServer();

    // Connect to the Archestra MCP server after Fastify is running
    try {
      // Add a small delay to ensure the MCP endpoint is ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      await ArchestraMcpClient.connect();
      log.info('Archestra MCP client connected successfully');
    } catch (error) {
      log.error('Failed to connect Archestra MCP client:', error);
      // Continue anyway - the app can work without Archestra tools
    }

    // Start Ollama server first
    await ollamaServer.startServer();

    /**
     * Ensure that ollama models that're required for various app functionality are available,
     * downloading them if necessary. This must be done BEFORE starting MCP servers
     * so that tool analysis can proceed without waiting forever.
     */
    await ollamaClient.ensureModelsAvailable();

    // Now start the sandbox manager which will connect MCP clients
    McpServerSandboxManager.onSandboxStartupSuccess = () => {
      log.info('Sandbox startup successful');
    };
    McpServerSandboxManager.onSandboxStartupError = (error) => {
      log.error('Sandbox startup error:', error);
    };
    McpServerSandboxManager.start();

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

ipcMain.handle('get-app-info', () => {
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  };
});

ipcMain.handle(
  'show-open-dialog',
  async (_event, options: { properties: Array<'openDirectory' | 'openFile' | 'multiSelections'> }) => {
    return dialog.showOpenDialog(mainWindow!, options);
  }
);

ipcMain.handle('get-system-info', () => {
  const os = require('os');
  const { execSync } = require('child_process');

  // Get CPU info
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Unknown';
  const cpuCores = cpus.length;

  // Get memory info
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  // Get disk info (macOS/Linux using df command, Windows using wmic)
  let diskInfo = { total: 0, free: 0, freePercent: '0' };
  try {
    if (process.platform === 'win32') {
      const output = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf8' });
      const lines = output.trim().split('\n').slice(1);
      let totalSize = 0;
      let totalFree = 0;
      lines.forEach((line: string) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[1] && parts[2]) {
          totalFree += parseInt(parts[1]) || 0;
          totalSize += parseInt(parts[2]) || 0;
        }
      });
      diskInfo.total = totalSize;
      diskInfo.free = totalFree;
      diskInfo.freePercent = totalSize > 0 ? ((totalFree / totalSize) * 100).toFixed(1) : '0';
    } else {
      // macOS and Linux
      const output = execSync('df -k /', { encoding: 'utf8' });
      const lines = output.trim().split('\n');
      const dataLine = lines[1];
      const parts = dataLine.split(/\s+/);
      const total = parseInt(parts[1]) * 1024; // Convert from KB to bytes
      const used = parseInt(parts[2]) * 1024;
      const available = parseInt(parts[3]) * 1024;
      diskInfo.total = total;
      diskInfo.free = available;
      diskInfo.freePercent = total > 0 ? ((available / total) * 100).toFixed(1) : '0';
    }
  } catch (error) {
    console.error('Error getting disk info:', error);
  }

  // Format sizes to human-readable
  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return gb.toFixed(2) + ' GB';
  };

  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    cpu: `${cpuModel} (${cpuCores} cores)`,
    totalMemory: formatBytes(totalMemory),
    freeMemory: formatBytes(freeMemory),
    totalDisk: formatBytes(diskInfo.total),
    freeDisk: formatBytes(diskInfo.free),
  };
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

    // Store authorization code for MCP OAuth flows using proxy
    if (params.code && params.state) {
      log.info('📥 Received OAuth callback with code and state, sending to backend server...');

      // Send authorization code to backend server via HTTP request
      const serverPort = process.env.ARCHESTRA_API_SERVER_PORT || '54587';
      const serverUrl = `http://localhost:${serverPort}/api/oauth/store-code`;

      log.info('🌐 About to send HTTP request to backend server');
      log.info('📍 Target URL:', serverUrl);
      log.info('🔌 Server port:', serverPort);
      log.info('📦 Request body:', JSON.stringify({ state: params.state, code: params.code }));

      fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: params.state,
          code: params.code,
        }),
      })
        .then((response) => {
          log.info('📥 Received response from backend server');
          log.info('📊 Response status:', response.status);
          log.info('📋 Response headers:', Object.fromEntries(response.headers.entries()));

          if (response.ok) {
            log.info('✅ HTTP request successful, parsing JSON response...');
            return response.json();
          } else {
            log.error('❌ HTTP request failed with status:', response.status);
            return response.text().then((errorText) => {
              log.error('📄 Error response body:', errorText);
              throw new Error(`HTTP ${response.status}: ${errorText}`);
            });
          }
        })
        .then((result) => {
          log.info('✅ Successfully sent authorization code to backend server');
          log.info('📨 Backend server response:', result);
        })
        .catch((error) => {
          log.error('❌ Failed to send authorization code to backend server');
          log.error('🔍 Error type:', error.constructor.name);
          log.error('📝 Error message:', error.message);
          log.error('📚 Error stack:', error.stack);

          // Check if it's a network error
          if (error.cause) {
            log.error('🔗 Error cause:', error.cause);
          }
        });
    }

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
  /**
   * IMPORTANT: create the main app window before starting the backend server.
   * Don't await for startBackendServer() to complete before creating the window as this
   * will lead to the main app window feeling like it's taking forever to boot up
   */
  createWindow();

  await startBackendServer();

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

/**
 * Handle graceful shutdown on app quit
 */
app.on('before-quit', async (event) => {
  if (!isCleaningUp) {
    event.preventDefault();
    await cleanup();
    app.quit(); // Quit after cleanup is done
  }
});

/**
 * Handle process termination signals for graceful shutdown
 */
process.on('SIGTERM', async () => {
  log.info('Received SIGTERM signal');
  await cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('Received SIGINT signal (Ctrl+C)');
  await cleanup();
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  log.error('Uncaught exception:', error);
  await cleanup();
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
  await cleanup();
  process.exit(1);
});
