/** Public bootstrap: secrets stay in process memory; only the approved script reaches disk. */
export const CLIENT_CONNECTION_INSTALLER = `#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('Usage: node connect.cjs --url https://deployment.example --client claude-code|cursor|codex|copilot-cli [--no-open]');
    return;
  }
  const origin = new URL(value('--url'));
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Use the deployment origin without credentials, a path, query, or fragment.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Use HTTPS (HTTP is allowed only on loopback for local development).');
  const clientId = value('--client');
  if (!['claude-code', 'cursor', 'codex', 'copilot-cli'].includes(clientId)) throw new Error('Choose --client claude-code, cursor, codex, or copilot-cli.');
  const platform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  if (!platform) throw new Error('Supported operating systems: macOS, Linux, Windows.');
  if (typeof fetch !== 'function') throw new Error('Node.js 18 or newer is required.');
  const request = async (path, body) => {
    const response = await fetch(new URL(path, origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { const error = new Error('Connection request failed (HTTP ' + response.status + '). Restart the installer or check the deployment URL.'); error.retryable = response.status === 429 || response.status >= 500; throw error; }
    return response.json();
  };
  const started = await request('/api/client-connections', { clientId, platform });
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
    await new Promise(resolve => setTimeout(resolve, 3000));
    let state;
    try { state = await request('/api/client-connections/poll', { deviceCode: started.deviceCode }); }
    catch (error) {
      if (!error.retryable && !(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
      console.log('Deployment temporarily unavailable. Retrying while approval is pending...');
      await new Promise(resolve => setTimeout(resolve, 7000));
      continue;
    }
    if (state.status === 'pending') continue;
    if (state.status !== 'approved') throw new Error('Connection ' + state.status + '. Start the installer again when ready.');
    const scriptPath = '/api/connection-setups/script/archestra_con_' + started.deviceCode;
    const response = await fetch(new URL(scriptPath, origin), { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Approved setup could not be downloaded (HTTP ' + response.status + '). Start the installer again.');
    const directory = await mkdtemp(join(tmpdir(), 'client-connect-'));
    try {
      const filename = join(directory, platform === 'windows' ? 'setup.ps1' : 'setup.sh');
      await writeFile(filename, await response.text(), { mode: 0o600 });
      console.log('Approval received. Applying the reviewed setup...');
      const child = platform === 'windows'
        ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filename], { stdio: 'inherit' })
        : spawnSync('bash', [filename], { stdio: 'inherit' });
      if (child.error || child.status !== 0) throw new Error('Setup failed. Review the output above and start the installer again after fixing the problem.');
      console.log('Setup applied. Restart or reload your client if needed. Complete its MCP sign-in if prompted.');
    } finally { await rm(directory, { recursive: true, force: true }); }
    return;
  }
  throw new Error('Connection expired. Start the installer again.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
