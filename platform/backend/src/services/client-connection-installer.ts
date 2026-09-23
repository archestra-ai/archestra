/** Public bootstrap: secrets stay in process memory; only the approved script reaches disk. */
export const CLIENT_CONNECTION_INSTALLER = String.raw`#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtemp, open, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('Usage: node connect.cjs --url https://deployment.example --client claude-code|claude-desktop|cursor|codex|copilot-cli|opencode [--no-open]');
    return;
  }
  const origin = new URL(value('--url'));
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Use the deployment origin without credentials, a path, query, or fragment.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.hostname.endsWith('.localhost')))) throw new Error('Use HTTPS (HTTP is allowed only on loopback for local development).');
  const networkOrigin = new URL(origin);
  if (networkOrigin.hostname.endsWith('.localhost')) networkOrigin.hostname = '127.0.0.1';
  const clientId = value('--client');
  const setupToken = value('--setup-token');
  if (setupToken && (clientId !== 'claude-desktop' || !/^archestra_con_[A-Za-z0-9_-]{32,43}$/.test(setupToken))) throw new Error('Invalid Desktop setup ticket.');
  if (!['claude-code', 'claude-desktop', 'cursor', 'codex', 'copilot-cli', 'opencode'].includes(clientId)) throw new Error('Choose --client claude-code, claude-desktop, cursor, codex, copilot-cli, or opencode.');
  const platform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  if (!platform) throw new Error('Supported operating systems: macOS, Linux, Windows.');
  if (typeof fetch !== 'function') throw new Error('Node.js 18 or newer is required.');
  if (clientId === 'claude-desktop' && !args.includes('--desktop-terminal')) {
    if (platform === 'linux' && spawnSync('which', ['claude-desktop'], { stdio: 'ignore' }).status !== 0) {
      throw new Error('Run Desktop setup in a terminal on the computer where Claude Desktop is installed. Cowork code execution runs in an isolated environment. Use the setup command in your own host terminal.');
    }
    await openDesktopTerminal({ origin: origin.origin, platform, noOpen: args.includes('--no-open'), setupToken });
    return;
  }
  if (setupToken) {
    await applySetup({ scriptPath: '/api/connection-setups/script/' + setupToken, origin: networkOrigin, platform });
    return;
  }
  const releaseLock = await acquireConnectionLock({ origin: origin.origin, clientId, platform });
  try {
    await runConnection({ args, clientId, networkOrigin, origin, platform });
  } finally {
    await releaseLock();
  }
}
async function runConnection({ args, clientId, networkOrigin, origin, platform }) {
  const request = async (path, body) => {
    const response = await fetch(new URL(path, networkOrigin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { const error = new Error('Connection request failed (HTTP ' + response.status + '). Restart the installer or check the deployment URL.'); error.retryable = response.status === 429 || response.status >= 500; throw error; }
    return response.json();
  };
  const started = await request('/api/client-connections', { clientId, platform });
  if (!Number.isSafeInteger(started.interval) || started.interval < 1 || started.interval > 600) throw new Error('Invalid polling interval.');
  const pollIntervalMs = started.interval * 1000;
  const verificationUrl = new URL(started.verificationPath, origin);
  if (verificationUrl.origin !== origin.origin || !/^[A-Za-z0-9_-]{43}$/.test(started.deviceCode)) throw new Error('Invalid connection response.');
  console.log('Open ' + verificationUrl.href);
  console.log('Check that the browser shows code ' + started.userCode + ', then review and approve the setup.');
  console.log('Waiting for browser approval. Press Ctrl+C to cancel.');
  if (!args.includes('--no-open')) {
    const command = platform === 'macos' ? 'open' : platform === 'windows' ? 'rundll32' : 'xdg-open';
    const openArgs = platform === 'windows' ? ['url.dll,FileProtocolHandler', verificationUrl.href] : [verificationUrl.href];
    const child = spawn(command, openArgs, { stdio: 'ignore' });
    child.on('error', () => console.log('Open the URL above in your browser.'));
    child.unref();
  }
  const deadline = Math.min(Date.parse(started.expiresAt), Date.now() + 600000);
  if (!Number.isFinite(deadline)) throw new Error('Invalid connection expiry.');
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    let state;
    try { state = await request('/api/client-connections/poll', { deviceCode: started.deviceCode }); }
    catch (error) {
      if (certificateError(error)) throw error;
      if (!error.retryable && !(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
      console.log('Deployment temporarily unavailable. Retrying while approval is pending...');
      await new Promise(resolve => setTimeout(resolve, 7000));
      continue;
    }
    if (state.status === 'pending') continue;
    if (state.status !== 'approved') throw new Error('Connection ' + state.status + '. Start the installer again when ready.');
    console.log('Browser approval confirmed.');
    const scriptPath = '/api/connection-setups/script/archestra_con_' + started.deviceCode;
    await applySetup({ scriptPath, origin: networkOrigin, platform });
    return;
  }
  throw new Error('Connection expired. Start the installer again.');
}
async function acquireConnectionLock({ origin, clientId, platform }) {
  const digest = createHash('sha256').update(origin + '\n' + clientId + '\n' + platform).digest('hex').slice(0, 24);
  const lockPath = join(tmpdir(), 'archestra-connect-' + digest + '.lock');
  const staleAfterMs = 15 * 60 * 1000;
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch {}
      const createdAt = Number(owner?.createdAt);
      const stale = !Number.isFinite(createdAt) || Date.now() - createdAt > staleAfterMs;
      if (!stale && Number.isSafeInteger(owner?.pid) && processIsRunning(owner.pid)) {
        throw new Error('Another connection installer is already running for this deployment and client. Keep its approval URL open. Do not start a second installer.');
      }
      if (attempt === 1) break;
      await rm(lockPath, { force: true });
    }
  }
  if (!handle) throw new Error('Could not acquire the connection installer lock. Retry after the existing installer exits.');
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n');
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      if (owner.pid === process.pid) await rm(lockPath, { force: true });
    } catch {}
  };
}
function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
async function applySetup({ scriptPath, origin, platform }) {
  const response = await fetch(new URL(scriptPath, origin), { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Approved setup could not be downloaded (HTTP ' + response.status + '). Start the installer again.');
  const directory = await mkdtemp(join(tmpdir(), 'client-connect-'));
  try {
    const filename = join(directory, platform === 'windows' ? 'setup.ps1' : 'setup.sh');
    const script = await response.text();
    // Windows PowerShell 5.1 reads a BOM-less .ps1 in the system ANSI codepage,
    // garbling the banner's Unicode mark and the startup-guard body the script
    // installs. A UTF-8 BOM makes powershell.exe -File decode it correctly.
    await writeFile(filename, platform === 'windows' ? '\uFEFF' + script : script, { mode: 0o600 });
    const lineCount = script.trimEnd().split(/\r?\n/).length;
    console.log('Downloaded approved setup (' + lineCount + ' lines). Applying now.');
    const child = platform === 'windows'
      ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filename], { stdio: 'inherit' })
      : spawnSync('bash', [filename], { stdio: 'inherit' });
    if (child.error || child.status !== 0) throw new Error('Setup failed. Review the output above and start the installer again after fixing the problem.');
    console.log('Setup applied. Restart or reload your client if needed. Complete its MCP sign-in if prompted.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function openDesktopTerminal({ origin, platform, noOpen, setupToken }) {
  // Desktop owns the agent process. A separate OS terminal survives its restart.
  // A reviewed download can also carry a short-lived, one-time setup ticket.
  const directory = await mkdtemp(join(tmpdir(), 'desktop-connect-'));
  const bootstrap = join(directory, 'connect.cjs');
  await writeFile(bootstrap, await readFile(__filename), { mode: 0o600 });
  const cliArgs = [bootstrap, '--url', origin, '--client', 'claude-desktop', '--desktop-terminal'];
  if (noOpen) cliArgs.push('--no-open');
  if (setupToken) cliArgs.push('--setup-token', setupToken);
  const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
  const shQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  let command, launchArgs;
  if (platform === 'windows') {
    const launcher = join(directory, 'connect.ps1');
    await writeFile(launcher, '& ' + [process.execPath, ...cliArgs].map(psQuote).join(' ') + '\n', { mode: 0o600 });
    command = 'powershell.exe';
    launchArgs = ['-NoProfile', '-Command', "Start-Process powershell.exe -ArgumentList @('-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File'," + psQuote('"' + launcher + '"') + ")"];
  } else {
    const launcher = join(directory, platform === 'macos' ? 'Connect.command' : 'connect.sh');
    await writeFile(launcher, '#!/usr/bin/env bash\n' + [process.execPath, ...cliArgs].map(shQuote).join(' ') + '\n', { mode: 0o700 });
    if (platform === 'macos') { command = 'open'; launchArgs = ['-a', 'Terminal', launcher]; }
    else {
      command = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find(name => spawnSync('which', [name], { stdio: 'ignore' }).status === 0);
      if (!command) { await rm(directory, { recursive: true, force: true }); throw new Error('Open a host terminal and run the same command with --desktop-terminal.'); }
      launchArgs = command === 'gnome-terminal' ? ['--', 'bash', launcher] : ['-e', 'bash', launcher];
    }
  }
  const child = spawn(command, launchArgs, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
  await new Promise((resolve, reject) => {
    // open/Start-Process exit after handoff; Linux terminal emulators may stay alive.
    const timeout = platform === 'linux' ? setTimeout(resolve, 2000) : undefined;
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('Could not open the setup terminal. Run setup in your host terminal. ' + diagnostic.trim()));
      else resolve();
    });
  });
  child.stderr.destroy();
  child.unref();
  console.log('Desktop setup opened in a separate terminal. Review its browser approval. The terminal will verify inference and restart Desktop; this conversation may close.');
}
/**
 * Node's fetch reports every transport failure as a TypeError reading only
 * 'fetch failed'. The reason sits on error.cause. A certificate the runtime
 * does not trust is the one reason a caller can fix, and it is easy to miss
 * because curl reads the system CA store while Node does not, so the same URL
 * works in the shell and fails here.
 */
function errorCode(error) {
  const code = error && error.cause && error.cause.code;
  return typeof code === 'string' ? code : undefined;
}
function certificateError(error) {
  const code = errorCode(error);
  return code !== undefined && (code.indexOf('CERT') !== -1 || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'UNABLE_TO_GET_ISSUER_CERT');
}
function describeError(error) {
  const code = errorCode(error);
  // A name mismatch is a certificate problem too, but a CA bundle never fixes
  // it, so it must not be answered with the CA advice below.
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'The deployment\'s TLS certificate is not valid for this hostname (' + code + '). Use the hostname the certificate was issued for in --url.';
  }
  if (certificateError(error)) {
    return 'Node.js does not trust this deployment\'s TLS certificate (' + code + '). curl can still succeed here, because it reads the system CA store and Node.js does not. Re-run with the CA bundle: NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt node <installer> --url ... (use your own bundle path; on macOS export it from Keychain Access).';
  }
  return code ? error.message + ' (' + code + ')' : error.message;
}
main().catch(error => { console.error(describeError(error)); process.exitCode = 1; });
`;
