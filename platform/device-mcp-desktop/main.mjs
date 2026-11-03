import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, Tray } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseDeviceEnrollmentUrl } from './deep-link.mjs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DeviceMcpCompanion } from '../backend/src/device-mcp-client/client.ts';
import { LocalDeviceClient, LocalDeviceAccessError } from '../backend/src/device-mcp-client/local-device-client.ts';
import { LocalDeviceStore, runStoredLocalDevice } from '../backend/src/device-mcp-client/local-device-store.ts';
import { parseDeviceConnectionFile } from '../backend/src/device-mcp-client/connection-file.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(directory, 'index.html')).href;
const branding = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).archestraDesktop;
if (!branding?.productName || branding.protocol !== 'archestra-device') throw new Error('Build this desktop app with deployment branding before running it.');
app.setName(branding.productName);
let window;
let tray;
let controller;
let busy = false;
let quitting = false;
let pendingFile;
let pendingEnrollment;
let readyForEnrollment = false;
let store;
let remembered;
const connectionJobs = new Set();
let status = { state: 'idle', title: 'Connect this computer', detail: `Return to Devices in your browser and choose Open ${branding.productName}.`, canReconnect: false, canEnableBrowserConnection: false };

function showStatus(next) {
  status = { ...status, ...next };
  if (window && !window.isDestroyed()) window.webContents.send('status', status);
}
function disconnect() {
  controller?.abort();
  controller = undefined;
  busy = false;
  showStatus({ state: 'idle', title: 'Disconnected', detail: 'This computer is offline. Reconnect when you want it available again.', canReconnect: !!remembered });
}
function startConnection(path) {
  const job = connectFile(path);
  connectionJobs.add(job);
  void job.catch(() => {
    if (!quitting) showStatus({ state: 'error', title: 'Connection needs attention', detail: 'Return to Connect and try again.' });
  }).finally(() => connectionJobs.delete(job));
}
async function prepareReplacement() {
  if (busy) {
    await dialog.showMessageBox(window, { type: 'info', message: 'A connection is already being prepared.', detail: 'Finish or cancel it before connecting again.' });
    return false;
  }
  busy = true;
  if (controller || remembered) {
    try {
      const choice = await dialog.showMessageBox(window, { type: 'question', message: 'Replace this computer’s current connection?', detail: 'Its current connection will stop after you choose Replace. You will then review and approve the new account connection.', buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) { busy = false; return false; }
      disconnect();
      busy = true;
    } catch (error) { busy = false; throw error; }
  }
  return true;
}
function track(job) {
  connectionJobs.add(job);
  void job.catch(() => {
    if (!quitting) showStatus({ state: 'error', title: 'Connection needs attention', detail: 'Return to Devices and try again.' });
  }).finally(() => connectionJobs.delete(job));
}
function receiveEnrollmentUrl(value) {
  try {
    if (!branding.browserHandoff) throw new Error('Browser handoff requires the signed desktop release.');
    const setup = parseDeviceEnrollmentUrl(value);
    if (!window || !readyForEnrollment) { pendingEnrollment = setup; return; }
    window.show(); window.focus();
    track((async () => { if (await prepareReplacement()) await connectLocalDevice(setup); })());
  } catch {
    if (window) void dialog.showMessageBox(window, { type: 'error', message: 'This device connection link is invalid.', detail: 'Return to Devices in your browser and try again.' });
  }
}
function enrollmentArgument(args) {
  const links = args.filter(value => /^archestra-device:/i.test(value));
  if (links.length === 1) { receiveEnrollmentUrl(links[0]); return true; }
  if (links.length > 1) {
    if (window) void dialog.showMessageBox(window, { type: 'error', message: 'Open one device connection at a time.' });
    return true;
  }
  return false;
}
async function enableBrowserConnections() {
  if (!branding.browserHandoff || !app.isPackaged) return;
  const choice = await dialog.showMessageBox(window, { type: 'question', title: 'Enable browser connections', message: `Allow browsers to open ${branding.productName}?`, detail: 'This lets the Devices page open the desktop app directly. Every new device connection still asks you to approve the account and computer.', buttons: ['Cancel', 'Enable'], defaultId: 0, cancelId: 0 });
  if (choice.response !== 1) return;
  if (!app.setAsDefaultProtocolClient(branding.protocol)) {
    await dialog.showMessageBox(window, { type: 'error', message: 'Browser connections could not be enabled.', detail: 'Install the signed desktop app and try again.' });
    return;
  }
  showStatus({ canEnableBrowserConnection: false, detail: `Return to Devices in your browser and choose Open ${branding.productName}.` });
}
async function connectFile(path) {
  if (!(await prepareReplacement())) return;
  let active;
  let cancelled = false;
  try {
    if (extname(path).toLowerCase() !== '.archestra') throw new Error('Choose a .archestra connection file downloaded from your Connect page.');
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 4096) throw new Error('This connection file is invalid or too large.');
    const setup = parseDeviceConnectionFile(await readFile(path, 'utf8'));
    if (setup.version === 2) {
      await connectLocalDevice(setup);
      return;
    }
    active = new AbortController();
    controller = active;
    showStatus({ state: 'connecting', title: 'Review this connection', detail: `Connecting to ${setup.url}` });
    const companion = new DeviceMcpCompanion(setup.url, undefined, message => {
      if (controller !== active || active.signal.aborted) return;
      showStatus({ state: message.startsWith('Device MCP is ready') ? 'online' : 'connecting', title: message.startsWith('Device MCP is ready') ? 'This computer is connected' : 'Reconnecting', detail: message });
    });
    await companion.pair(setup.code, async ({ config, configDigest, launch }) => {
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: 'Allow device tools?', signal: active.signal,
        message: `Allow ${new URL(setup.url).host} to use these tools on this computer?`,
        detail: `Tools: ${config.tools.map(tool => tool.name).join(', ')}\nVersion: ${config.version}\n\nThis starts ${basename(launch.command)} in your signed-in session. Your account can use these tools while the desktop app is open. Disconnect here or revoke access in your browser at any time.`,
        checkboxLabel: 'Review technical launch details', checkboxChecked: false,
        buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) { cancelled = true; return false; }
      if (result.checkboxChecked) {
        const review = await dialog.showMessageBox(window, { type: 'question', title: 'Review launch settings', signal: active.signal, message: 'Allow this reviewed configuration?', detail: `Executable: ${launch.command}\nArguments: ${JSON.stringify(launch.args)}\nConfiguration: ${configDigest}`, buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, noLink: true });
        if (review.response !== 1) { cancelled = true; return false; }
      }
      return !active.signal.aborted;
    }, active.signal);
    if (controller !== active || active.signal.aborted) return;
    busy = false;
    await companion.run(active.signal);
    if (controller === active && !active.signal.aborted) showStatus({ state: 'idle', title: 'Connection stopped', detail: 'Return to Connect to connect this computer again.' });
  } catch (error) {
    if (cancelled && controller === active) showStatus({ state: 'idle', title: 'Connection cancelled', detail: 'No device access was granted. You can connect again from your browser.' });
    else if ((!active || controller === active) && !active?.signal.aborted) showStatus({ state: 'error', title: 'Connection needs attention', detail: error instanceof Error ? error.message : 'Return to Connect and download a new connection file.' });
  } finally {
    active?.abort();
    if (!active || controller === active) busy = false;
    if (controller === active) controller = undefined;
  }
}
async function connectLocalDevice(setup) {
  const active = new AbortController();
  controller = active;
  showStatus({ state: 'connecting', title: 'Review this computer', detail: `Connecting to ${new URL(setup.url).host}`, canReconnect: false });
  let cancelled = false;
  let enrolled;
  try {
    const client = new LocalDeviceClient(setup.url);
    enrolled = await client.enroll(setup.code, { platform: process.platform, arch: process.arch, appVersion: app.getVersion() }, async details => {
      const choice = await dialog.showMessageBox(window, {
        type: 'question', title: 'Connect this computer', signal: active.signal,
        message: `Connect “${details.name}” to ${new URL(setup.url).host}?`,
        detail: `Account: ${details.ownerName}\nOrganization: ${details.organizationName}\n\nShare this computer's name, operating system, desktop app version and connection status with your account.\n\nSave the connection securely on this computer so it can reconnect when you reopen the app. You can disconnect here or revoke this device in Personal Settings → Devices.`,
        buttons: ['Cancel', 'Connect'], defaultId: 0, cancelId: 0, noLink: true,
      });
      cancelled = choice.response !== 1;
      if (!cancelled && !active.signal.aborted) await store.assertAvailable();
      return !cancelled && !active.signal.aborted;
    }, active.signal);
    if (controller !== active || active.signal.aborted) return;
    try { await store.save(enrolled); }
    catch (error) {
      // The proof was redeemed but no credential is retained if OS vault storage fails.
      remembered = undefined;
      showStatus({ state: 'error', title: 'Connection could not be saved', detail: 'Unlock your credential store, revoke this pending device in Personal Settings → Devices, and try again.', canReconnect: false });
      throw error;
    }
    remembered = enrolled;
    busy = false;
    await serveLocalDevice(client, enrolled, active);
  } catch (error) {
    if (controller === active && !active.signal.aborted) {
      if (cancelled) showStatus({ state: 'idle', title: 'Connection cancelled', detail: 'Add this computer again whenever you are ready.', canReconnect: !!remembered });
      else showStatus({ state: 'error', title: 'Connection needs attention', detail: error instanceof Error ? error.message : 'Return to Personal Settings → Devices and try again.', canReconnect: !!remembered });
    }
  } finally {
    active.abort();
    if (controller === active) { controller = undefined; busy = false; }
  }
}
async function serveLocalDevice(client, credential, active) {
  try {
    await runStoredLocalDevice(store, client, credential, (state, name) => {
      if (controller !== active || active.signal.aborted) return;
      showStatus({ state, title: name, detail: state === 'online' ? `Connected to ${new URL(credential.url).host}\nManage this computer in Personal Settings → Devices.` : 'Connection interrupted. Reconnecting securely…', canReconnect: false });
    }, active.signal);
  } catch (error) {
    if (controller !== active || active.signal.aborted) return;
    if (error instanceof LocalDeviceAccessError && error.credentialInvalid) {
      remembered = undefined;
      showStatus({ state: 'error', title: 'Connect this computer again', detail: error.message, canReconnect: false });
    } else showStatus({ state: 'error', title: 'Connection needs attention', detail: error instanceof Error ? error.message : 'Choose Reconnect to try again.', canReconnect: !!remembered });
  }
}
async function reconnect() {
  if (!remembered || controller || busy) return;
  const active = new AbortController();
  controller = active;
  const credential = remembered;
  showStatus({ state: 'connecting', title: credential.name, detail: 'Reconnecting securely…', canReconnect: false });
  try { await serveLocalDevice(new LocalDeviceClient(credential.url), credential, active); }
  finally { active.abort(); if (controller === active) controller = undefined; }
}
async function openFile() {
  const choice = await dialog.showOpenDialog(window, { title: 'Open device connection', properties: ['openFile'], filters: [{ name: `${branding.appName} developer connection`, extensions: ['archestra'] }] });
  if (!choice.canceled && choice.filePaths[0]) startConnection(choice.filePaths[0]);
}
function trusted(event) { return event.sender === window?.webContents && event.senderFrame?.url === page; }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('open-url', (event, url) => { event.preventDefault(); receiveEnrollmentUrl(url); });
  app.on('open-file', (event, path) => { event.preventDefault(); if (app.isReady()) startConnection(path); else pendingFile = path; });
  app.on('second-instance', (_event, args) => { window?.show(); window?.focus(); if (enrollmentArgument(args)) return; const file = args.find(arg => extname(arg).toLowerCase() === '.archestra'); if (file) startConnection(file); });
  app.whenReady().then(async () => {
    store = new LocalDeviceStore(join(app.getPath('userData'), 'local-device.enc'), { isAvailable: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: value => safeStorage.encryptStringAsync(value), decrypt: async value => (await safeStorage.decryptStringAsync(value)).result });
    window = new BrowserWindow({ width: 600, height: 500, minWidth: 450, minHeight: 400, title: branding.productName, autoHideMenuBar: true, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle('enable-browser-connections', event => trusted(event) ? enableBrowserConnections() : undefined);
    ipcMain.handle('disconnect', event => { if (trusted(event)) disconnect(); });
    ipcMain.handle('reconnect', event => { if (trusted(event)) { const job = reconnect(); connectionJobs.add(job); void job.finally(() => connectionJobs.delete(job)); } });
    ipcMain.handle('status', event => trusted(event) ? status : undefined);
    const compatibilityMenu = branding.browserHandoff ? [] : [{ label: 'Open developer connection file…', click: openFile }];
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: branding.productName, submenu: [{ label: 'Enable browser connections…', click: enableBrowserConnections }, ...compatibilityMenu, { label: 'Disconnect', click: disconnect }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }]));
    tray = new Tray(await app.getFileIcon(process.execPath, { size: 'small' }));
    tray.setToolTip(branding.productName);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: `Show ${branding.productName}`, click: () => window.show() }, { label: 'Disconnect', click: disconnect }, { type: 'separator' }, { role: 'quit' }]));
    tray.on('click', () => window.show());
    await window.loadURL(page);
    showStatus({ canEnableBrowserConnection: branding.browserHandoff && !app.isDefaultProtocolClient(branding.protocol) });
    try { remembered = await store.load(); }
    catch { showStatus({ state: 'error', title: 'Saved connection needs attention', detail: 'Unlock your computer’s credential store and reopen the app. Your connection remains encrypted.' }); }
    readyForEnrollment = true;
    if (pendingEnrollment) {
      const setup = pendingEnrollment; pendingEnrollment = undefined;
      track((async () => { if (await prepareReplacement()) await connectLocalDevice(setup); })());
    } else if (!enrollmentArgument(process.argv)) {
      const file = pendingFile ?? process.argv.find(arg => extname(arg).toLowerCase() === '.archestra');
      pendingFile = undefined;
      if (file) startConnection(file);
      else if (remembered) track(reconnect());
    }
    window.on('close', event => {
      if (!quitting) { event.preventDefault(); window.hide(); }
    });
  });
  app.on('activate', () => window?.show());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    disconnect();
    void Promise.allSettled([...connectionJobs]).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !controller) app.quit(); });
}
