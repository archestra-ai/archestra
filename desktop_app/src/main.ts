import * as Sentry from '@sentry/electron/main';
import chokidar from 'chokidar';
import { BrowserWindow, NativeImage, app, ipcMain, nativeImage, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { updateElectronApp } from 'update-electron-app';

import log from '@backend/utils/logger';

import config from './config';
import { setupProviderBrowserAuthHandlers } from './main-browser-auth';

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

let serverProcess: ChildProcess | null = null;
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
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

/**
 * Start the backendin a separate Node.js process
 *
 * This function spawns the backend as a child process because:
 * 1. The backend needs access to native Node.js modules (better-sqlite3)
 * 2. Electron's renderer process has restrictions on native modules
 * 3. Running in a separate process allows for better error isolation
 * 4. The server can be restarted independently of the Electron app
 */
async function startBackendServer(): Promise<void> {
  // server-process.js is built by Vite from src/server-process.ts
  // It's placed in the same directory as main.js after building
  const serverPath = path.join(__dirname, 'server-process.js');

  // If there's an existing server process, kill it and wait for it to exit
  if (serverProcess) {
    await new Promise<void>((resolve) => {
      const existingProcess = serverProcess;

      // Set up a one-time listener for the exit event
      if (existingProcess) {
        existingProcess.once('exit', () => {
          log.info('Previous server process has exited');
          resolve();
        });

        // Send SIGTERM to trigger graceful shutdown
        existingProcess.kill('SIGTERM');

        // If process doesn't exit after 5 seconds, force kill it
        setTimeout(() => {
          if (existingProcess.killed === false) {
            log.warn('Server process did not exit gracefully, force killing');
            existingProcess.kill('SIGKILL');
          }
          resolve();
        }, 5000);
      } else {
        resolve();
      }
    });

    // Wait a bit more to ensure ports are released
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * Fork creates a new Node.js process that can communicate with the parent
   * pass --transpileOnly (disable type checking) to increase startup speed
   *
   * https://github.com/fastify/fastify/discussions/3795#discussioncomment-4690921
   */
  serverProcess = fork(serverPath, ['--transpileOnly'], {
    env: {
      ...process.env,
      // CRITICAL: This flag tells Electron to run this process as pure Node.js
      // Without it, the process would run as an Electron process and fail to load native modules
      ELECTRON_RUN_AS_NODE: '1',
      /**
       * NOTE: we are passing these paths in here because electron's app object is not available in
       * forked processes..
       *
       * According to https://www.electronjs.org/docs/latest/api/app#appgetpathname
       *
       * userData - The directory for storing your app's configuration files, which by default is the appData directory
       * appended with your app's name. By convention files storing user data should be written to this directory, and
       * it is not recommended to write large files here because some environments may backup this directory to cloud
       * storage.
       * logs - Directory for your app's log folder.
       */
      ARCHESTRA_USER_DATA_PATH: app.getPath('userData'),
      ARCHESTRA_LOGS_PATH: app.getPath('logs'),
    },
    silent: false, // Allow console output from child process for debugging
  });

  // Handle server process errors
  serverProcess.on('error', (error) => {
    log.error('Server process error:', error);
  });

  // Handle server process exit
  serverProcess.on('exit', (code, signal) => {
    log.info(`Server process exited with code ${code} and signal ${signal}`);
    serverProcess = null;
  });
}

// Set up IPC handler for opening external links
ipcMain.handle('open-external', async (_event, url: string) => {
  await shell.openExternal(url);
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

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  if (config.debug) {
    const serverPath = path.resolve(__dirname, '.vite/build/server-process.js');

    chokidar.watch(serverPath).on('change', async () => {
      log.info('Restarting server..');
      await startBackendServer();
    });
  }
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

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Gracefully stop server on quit
app.on('before-quit', async (event) => {
  if (serverProcess) {
    event.preventDefault();

    // Kill the server process gracefully
    if (serverProcess) {
      serverProcess.kill('SIGTERM');

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        if (!serverProcess) {
          resolve();
          return;
        }

        serverProcess.on('exit', () => {
          resolve();
        });

        // Force kill after 5 seconds
        setTimeout(() => {
          if (serverProcess) {
            serverProcess.kill('SIGKILL');
          }
          resolve();
        }, 5000);
      });
    }

    app.exit();
  }
});

// Clean up on unexpected exit
process.on('exit', async () => {
  if (serverProcess) {
    serverProcess.kill('SIGKILL');
  }
});
