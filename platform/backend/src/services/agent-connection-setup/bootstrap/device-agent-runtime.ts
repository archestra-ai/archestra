/** Dependency-free Node payload, installed by Connect after explicit browser approval. */
export const DEVICE_AGENT_RUNTIME = String.raw`'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync, fork } = require('node:child_process');
const VERSION = '1.0.0';
function origin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid deployment origin.');
  return url.origin;
}
function identity(url, userId) {
  if (typeof userId !== 'string' || !userId || userId.length > 256) throw new Error('Invalid approved account.');
  const id = createHash('sha256').update(origin(url) + '\n' + userId).digest('hex').slice(0, 32);
  return { id, label: 'ai.archestra.device.' + id, root: join(homedir(), '.local', 'share', 'archestra-device', id) };
}
function command(file, args, input, operation = file) {
  const result = spawnSync(file, args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.stderr || '').match(/DEVICE_AGENT_ERROR:([A-Za-z0-9_.,:+-]{1,240})/);
    const error = new Error('Could not complete ' + operation + ' (exit ' + result.status + (result.error ? ', ' + result.error.code : '') + (diagnostic ? ', ' + diagnostic[1] : '') + '). Check your user service manager and unlocked credential store.');
    error.status = result.status;
    throw error;
  }
  return result.stdout.trim();
}
function powershell(script, value, operation) {
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from('try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding; $ErrorActionPreference = "Stop"; $p = [Console]::In.ReadToEnd() | ConvertFrom-Json; ' + script + ' } catch { [Console]::Error.WriteLine("DEVICE_AGENT_ERROR:" + $_.FullyQualifiedErrorId + ":" + $_.Exception.HResult); exit 1 }', 'utf16le').toString('base64')], JSON.stringify(value), operation || 'Windows user service operation');
}
function keychainQuote(value) { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '') + '"'; }
async function writePrivate(path, value) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { await fs.writeFile(temp, value, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, path); }
  finally { await fs.rm(temp, { force: true }); }
}
async function readPrivate(path) {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid device state file.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
async function vault(action, spec, token) {
  if (process.platform === 'darwin') {
    const args = ['-s', spec.label, '-a', spec.id];
    if (action === 'save') {
      // Secret travels over stdin, never process arguments or the filesystem.
      command('/usr/bin/security', ['-i'], 'add-generic-password -U -s ' + keychainQuote(spec.label) + ' -a ' + keychainQuote(spec.id) + ' -w ' + keychainQuote(token) + '\n');
      return;
    }
    try { return command('/usr/bin/security', [action === 'load' ? 'find-generic-password' : 'delete-generic-password', ...args, ...(action === 'load' ? ['-w'] : [])]); }
    catch (error) { if (error.status === 44) return null; throw error; }
  }
  if (process.platform === 'win32') {
    const path = join(spec.root, 'credential.dpapi');
    if (action === 'clear') { await fs.rm(path, { force: true }); return; }
    if (action === 'save') {
      const encrypted = powershell('$s = ConvertTo-SecureString $p.value -AsPlainText -Force; $s | ConvertFrom-SecureString', { value: token }, 'Windows credential encryption');
      await writePrivate(path, encrypted);
      return;
    }
    let encrypted;
    try { encrypted = await readPrivate(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return powershell('$s = ConvertTo-SecureString $p.value; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }', { value: encrypted }, 'Windows credential decryption');
  }
  if (process.platform === 'linux') {
    const args = ['service', spec.label, 'account', spec.id];
    if (action === 'save') { command('secret-tool', ['store', '--label=Local device connection', ...args], token); return; }
    try { return command('secret-tool', [action === 'load' ? 'lookup' : 'clear', ...args]); }
    catch (error) { if (error.status === 1) return null; throw error; }
  }
  throw new Error('Unsupported operating system.');
}
function xml(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function servicePath(spec) {
  return process.platform === 'darwin' ? join(homedir(), 'Library', 'LaunchAgents', spec.label + '.plist') : join(homedir(), '.config', 'systemd', 'user', spec.label + '.service');
}
function windowsArguments(script) {
  // A path cannot end in a slash here; disallow characters with ambiguous CLI parsing.
  if (/["\r\n]/.test(script)) throw new Error('Unsupported installation path.');
  return '"' + script + '" run';
}
function serviceDefinition(spec, node) {
  if (/[\r\n]/.test(spec.root + node)) throw new Error('Unsupported installation path.');
  const script = join(spec.root, 'agent.cjs');
  if (process.platform === 'darwin') return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>' + spec.label + '</string><key>ProgramArguments</key><array><string>' + xml(node) + '</string><string>' + xml(script) + '</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>' + xml(homedir()) + '</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>15</integer></dict></plist>';
  const escape = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$') + '"';
  return '[Unit]\nDescription=Personal local device agent\n[Service]\nExecStart=' + escape(node) + ' ' + escape(script) + ' run\nRestart=on-failure\nRestartSec=15\nUMask=0077\n[Install]\nWantedBy=default.target\n';
}
async function service(action, spec, node = process.execPath) {
  if (process.platform === 'win32') {
    const options = { label: spec.label, node, args: windowsArguments(join(spec.root, 'agent.cjs')), root: spec.root };
    const stop = 'if (Get-ScheduledTask -TaskName $p.label -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $p.label; $until = [DateTime]::UtcNow.AddSeconds(20); while ((Get-ScheduledTask -TaskName $p.label).State -eq "Running") { if ([DateTime]::UtcNow -gt $until) { throw "Device agent did not stop" }; Start-Sleep -Milliseconds 200 } }';
    if (action === 'stop') { powershell(stop, options, 'Windows agent stop'); return; }
    if (action === 'remove') { powershell(stop + ' if (Get-ScheduledTask -TaskName $p.label -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $p.label -Confirm:$false }', options, 'Windows agent removal'); return; }
    if (action === 'install') {
      powershell('$u = [Security.Principal.WindowsIdentity]::GetCurrent().Name; $a = New-ScheduledTaskAction -Execute $p.node -Argument $p.args -WorkingDirectory $p.root; $t = New-ScheduledTaskTrigger -AtLogOn -User $u; $principal = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew; Register-ScheduledTask -TaskName $p.label -Action $a -Trigger $t -Principal $principal -Settings $s -Force | Out-Null; Start-ScheduledTask -TaskName $p.label', options, 'Windows agent registration/start');
    } else powershell('Start-ScheduledTask -TaskName $p.label', options, 'Windows agent registration/start');
    return;
  }
  const path = servicePath(spec);
  if (process.platform === 'darwin') {
    const domain = 'gui/' + process.getuid();
    if (action === 'stop' || action === 'remove') {
      const stopped = spawnSync('/bin/launchctl', ['bootout', domain + '/' + spec.label], { encoding: 'utf8', timeout: 15000 });
      if (stopped.error || ![0, 3, 113].includes(stopped.status)) throw new Error('Could not stop the existing device agent.');
      if (action === 'remove') await fs.rm(path, { force: true });
      return;
    }
    if (action === 'install') {
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writePrivate(path, serviceDefinition(spec, node));
    }
    // A stopped job is unloaded; start installs it again without duplicate processes.
    const loaded = spawnSync('/bin/launchctl', ['print', domain + '/' + spec.label], { stdio: 'ignore', timeout: 15000 });
    if (loaded.status !== 0) command('/bin/launchctl', ['bootstrap', domain, path]);
    command('/bin/launchctl', ['kickstart', '-k', domain + '/' + spec.label]);
    return;
  }
  if (action === 'install') {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writePrivate(path, serviceDefinition(spec, node));
    command('systemctl', ['--user', 'daemon-reload']);
    command('systemctl', ['--user', 'enable', '--now', spec.label]);
  } else if (action === 'remove') {
    command('systemctl', ['--user', 'disable', '--now', spec.label]);
    await fs.rm(path, { force: true });
    command('systemctl', ['--user', 'daemon-reload']);
  } else command('systemctl', ['--user', action === 'stop' ? 'stop' : 'start', spec.label]);
}
async function request(url, path, body, token) {
  const response = await fetch(new URL('/api/local-devices/' + path, origin(url)), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) { const error = new Error('Device connection failed (HTTP ' + response.status + ').'); error.status = response.status; throw error; }
  return response.json();
}
async function lock(spec) {
  const path = join(spec.root, 'install.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.close();
      return () => fs.rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readPrivate(path));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid device install lock.');
      try { process.kill(pid, 0); throw new Error('Another device setup is running. Wait for it to finish.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await fs.rm(path);
    }
  }
  throw new Error('Could not lock device setup.');
}
async function preflight(options) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('The background agent requires Node.js 22 or newer.');
  const spec = identity(origin(options.url), options.userId);
  await fs.mkdir(spec.root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(spec.root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe device installation directory.');
  if (process.platform !== 'win32') await fs.chmod(spec.root, 0o700);
  if (process.platform === 'darwin') command('/bin/launchctl', ['print', 'gui/' + process.getuid()]);
  else if (process.platform === 'win32') powershell('Get-Command Register-ScheduledTask, Start-ScheduledTask, ConvertFrom-SecureString | Out-Null', {}, 'Windows agent prerequisite check');
  else if (process.platform === 'linux') command('systemctl', ['--user', 'show-environment']);
  else throw new Error('Unsupported operating system.');
  const existing = await vault('load', spec);
  if (!existing) {
    const probe = { ...spec, id: spec.id + '-probe', label: spec.label + '.probe' };
    try { const value = randomBytes(24).toString('base64url'); await vault('save', probe, value); if (await vault('load', probe) !== value) throw new Error('Credential storage verification failed.'); }
    finally { await vault('clear', probe); }
  }
}
async function install(options) {
  const url = origin(options.url);
  if (typeof options.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(options.code)) throw new Error('Invalid device setup approval.');
  if (!['darwin', 'win32', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported device platform.');
  const spec = identity(url, options.userId);
  await fs.mkdir(spec.root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(spec.root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe device installation directory.');
  if (process.platform !== 'win32') await fs.chmod(spec.root, 0o700);
  const unlock = await lock(spec);
  let credential;
  let oldToken;
  let saved = false;
  let backup;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    oldToken = await vault('load', spec);
    if (!oldToken) {
      const probe = { ...spec, id: spec.id + '-probe', label: spec.label + '.probe' };
      try { const value = randomBytes(24).toString('base64url'); await vault('save', probe, value); if (await vault('load', probe) !== value) throw new Error('Credential storage verification failed.'); }
      finally { await vault('clear', probe); }
    }
    credential = await request(url, 'install', { code: options.code, platform: process.platform, arch: process.arch, appVersion: VERSION }, oldToken);
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(credential.token) || !/^[a-f0-9-]{36}$/.test(credential.deviceId)) throw new Error('Invalid device enrollment response.');
    // Stop first so a previous process cannot remove the replacement credential.
    let previous = false;
    try { await readPrivate(join(spec.root, 'config.json')); previous = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      if (!credential.created) backup = { config: await readPrivate(join(spec.root, 'config.json')), source: await readPrivate(join(spec.root, 'agent.cjs')) };
      await service('stop', spec);
      let prior;
      try { prior = JSON.parse(await readPrivate(join(spec.root, 'status.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const stopDeadline = Date.now() + 20000;
      while (prior && Number.isSafeInteger(prior.pid) && prior.pid > 0) {
        try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() >= stopDeadline) throw new Error('The previous device agent did not stop.');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    if (interrupted) throw new Error('Device setup cancelled.');
    await vault('save', spec, credential.token);
    if (await vault('load', spec) !== credential.token) throw new Error('Could not verify saved device credential.');
    saved = true;
    await writePrivate(join(spec.root, 'agent.cjs'), await fs.readFile(__filename));
    const config = { url, userId: options.userId, appName: options.appName, deviceId: credential.deviceId, name: credential.name, expiresAt: credential.expiresAt, node: process.execPath, path: process.env.PATH };
    await writePrivate(join(spec.root, 'config.json'), JSON.stringify(config));
    await fs.rm(join(spec.root, 'status.json'), { force: true });
    const began = Date.now();
    console.log('Status: ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(spec.root, 'agent.cjs')) + ' status');
    await service('install', spec);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('Device setup cancelled.');
      let status;
      try { status = JSON.parse(await readPrivate(join(spec.root, 'status.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (status && status.updatedAt >= began && status.deviceId === credential.deviceId) {
        if (status.state === 'online') {
          console.log('Background agent connected. It starts automatically after login.');
          console.log('Manage: ' + url + '/account/devices');
          console.log('Status: ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(spec.root, 'agent.cjs')) + ' status');
          console.log('Remove: ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(spec.root, 'agent.cjs')) + ' uninstall');
          return;
        }
        if (['revoked', 'superseded', 'storage-error'].includes(status.state)) throw new Error('Background agent could not connect: ' + status.state + '.');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Background agent did not check in. Run the printed status command or run Connect again.');
  } catch (error) {
    // A failed first install must not leave a valid credential or a startup job.
    if (credential && credential.created) {
      if (saved) { try { await service('remove', spec); } catch {} }
      try { await request(url, 'remove-agent', {}, credential.token); } catch {}
      await vault('clear', spec);
    }
    if (backup) {
      try {
        await service('stop', spec);
        await vault('save', spec, oldToken);
        await writePrivate(join(spec.root, 'agent.cjs'), backup.source);
        await writePrivate(join(spec.root, 'config.json'), backup.config);
        await service('install', spec, JSON.parse(backup.config).node);
      } catch { console.error('The previous background agent could not be restored. Run Connect again.'); }
    }
    throw error;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); await unlock(); }
}
function mcpSupervisor(config, spec, token) {
  const workers = new Map();
  let cachedHash;
  const report = () => writePrivate(join(spec.root, 'mcp-status.json'), JSON.stringify(Array.from(workers, ([id, item]) => ({ id, state: item.state, reason: item.reason || null }))));
  async function stop(item) {
    if (!item.child) return;
    const child = item.child; item.child = null;
    if (child.connected) child.disconnect(); else child.kill('SIGTERM');
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  return {
    async sync() {
      const manifest = await request(config.url, 'mcp-sync', {}, token);
      if (!Array.isArray(manifest.installations) || manifest.installations.length > 32) throw new Error('Invalid MCP manifest.');
      const wanted = new Set(manifest.installations.map(item => item.id));
      await Promise.all(Array.from(workers, async ([id, item]) => { if (!wanted.has(id)) { await stop(item); workers.delete(id); } }));
      for (const installation of manifest.installations) {
        if (!/^[a-f0-9-]{36}$/.test(installation.id) || !/^[a-f0-9]{64}$/.test(installation.configDigest)) throw new Error('Invalid MCP installation.');
        let item = workers.get(installation.id);
        if (item && item.digest !== installation.configDigest) { await stop(item); workers.delete(installation.id); item = undefined; }
        if (item && (item.child || item.retryAt > Date.now())) continue;
        if (cachedHash !== manifest.workerSha256) {
          const bundle = await request(config.url, 'mcp-worker', {}, token);
          if (typeof bundle.source !== 'string' || Buffer.byteLength(bundle.source) > 8 * 1024 * 1024 || createHash('sha256').update(bundle.source).digest('hex') !== manifest.workerSha256 || bundle.sha256 !== manifest.workerSha256) throw new Error('MCP worker integrity check failed.');
          await writePrivate(join(spec.root, 'mcp-worker.cjs'), bundle.source);
          cachedHash = bundle.sha256;
        }
        const session = await request(config.url, 'mcp-open', { id: installation.id, configDigest: installation.configDigest }, token);
        if (session.configDigest !== installation.configDigest || createHash('sha256').update(JSON.stringify(session.config)).digest('hex') !== installation.configDigest) throw new Error('MCP approval changed.');
        const environment = {};
        for (const key of ['HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) environment[key] = process.env[key];
        environment.PATH = config.path || process.env.PATH;
        const child = fork(join(spec.root, 'mcp-worker.cjs'), [], { execPath: config.node, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: environment });
        const next = { child, digest: installation.configDigest, state: 'starting', retryAt: 0, failures: item ? item.failures : 0 };
        workers.set(installation.id, next);
        child.on('message', message => { if (message && ['ready', 'connecting', 'failed'].includes(message.state)) { next.state = message.state; next.reason = message.reason; void report().catch(() => {}); } });
        child.once('exit', () => { next.child = null; next.state = 'stopped'; next.failures++; next.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(next.failures, 5)); void report().catch(() => {}); });
        child.once('error', () => { next.state = 'failed'; next.reason = 'MCP worker could not start'; });
        child.send({ ...session, url: config.url });
      }
      await report();
    },
    async stop() { await Promise.all(Array.from(workers.values(), stop)); workers.clear(); await report(); },
  };
}
async function run(config, spec) {
  let token;
  let mcps;
  let sessionId;
  let stopped = false;
  let wake;
  const status = state => writePrivate(join(spec.root, 'status.json'), JSON.stringify({ state, deviceId: config.deviceId, updatedAt: Date.now(), pid: process.pid }));
  const stop = () => { stopped = true; if (wake) wake(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const sleep = ms => new Promise(resolve => { const timer = setTimeout(() => { wake = undefined; resolve(); }, ms); wake = () => { clearTimeout(timer); wake = undefined; resolve(); }; });
  let backoff = 1000;
  try {
    try { token = await vault('load', spec); } catch { await status('storage-error'); process.exitCode = 1; return; }
    if (!token) {
      let previous;
      try { previous = JSON.parse(await readPrivate(join(spec.root, 'status.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous && previous.state === 'revoked') { await status('revoked'); return; }
      // A locked/unready vault at login is retried by the service manager.
      await status('storage-error'); process.exitCode = 1; return;
    }
    mcps = mcpSupervisor(config, spec, token);
    while (!stopped) {
      try {
        if (Date.parse(config.expiresAt) <= Date.now()) { await vault('clear', spec); await status('revoked'); return; }
        if (!sessionId) sessionId = (await request(config.url, 'session', {}, token)).sessionId;
        const result = await request(config.url, 'heartbeat', { sessionId }, token);
        if (result.success !== true) throw new Error('Invalid heartbeat.');
        await status('online'); backoff = 1000;
        await mcps.sync();
        await sleep(15000);
      } catch (error) {
        if (error.status === 401 || error.status === 403) { await vault('clear', spec); await status('revoked'); return; }
        if (error.status === 409) { await status('superseded'); return; }
        await status('connecting'); sessionId = undefined;
        await sleep(backoff + Math.floor(Math.random() * 500)); backoff = Math.min(backoff * 2, 30000);
      }
    }
  } finally {
    if (mcps) await mcps.stop();
    if (token && sessionId) { try { await request(config.url, 'disconnect', { sessionId }, token); } catch {} }
    if (stopped) await status('stopped');
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
async function main() {
  const action = process.argv[2];
  if (action === 'install' || action === 'preflight') {
    let data = ''; for await (const chunk of process.stdin) { data += chunk; if (data.length > 16384) throw new Error('Invalid installation input.'); }
    return action === 'preflight' ? preflight(JSON.parse(data)) : install(JSON.parse(data));
  }
  const config = JSON.parse(await readPrivate(join(__dirname, 'config.json')));
  const spec = identity(config.url, config.userId);
  if (spec.root !== __dirname) throw new Error('Run the installed agent from its original location.');
  if (action === 'status') {
    let state = { state: 'not started' };
    try { state = JSON.parse(await readPrivate(join(spec.root, 'status.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.state === 'online' && Date.now() - state.updatedAt > 45000) state.state = 'offline';
    console.log(JSON.stringify(state, null, 2));
    try { console.log(await readPrivate(join(spec.root, 'mcp-status.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  if (action === 'uninstall') {
    const token = await vault('load', spec);
    await service('remove', spec, config.node);
    let remoteRevoked = true;
    if (token) { try { await request(config.url, 'remove-agent', {}, token); } catch (error) { if (![401, 403].includes(error.status)) remoteRevoked = false; } }
    await vault('clear', spec);
    // Remove only files owned by this installer, never recursively delete a user path.
    for (const file of ['agent.cjs', 'config.json', 'status.json', 'credential.dpapi', 'mcp-worker.cjs', 'mcp-status.json']) await fs.rm(join(spec.root, file), { force: true });
    console.log('Background agent removed and device credential cleared.');
    if (!remoteRevoked) console.log('Remote revocation could not be confirmed. Revoke this computer at ' + config.url + '/account/devices.');
    return;
  }
  if (action === 'start' || action === 'stop') return service(action, spec, config.node);
  if (action !== 'run') throw new Error('Choose status, start, stop, or uninstall.');
  return run(config, spec);
}
module.exports = { identity, origin, serviceDefinition, windowsArguments, keychainQuote, install, preflight, run, main };
if (require.main === module) main().catch((error) => { console.error('Local device agent failed. Check the OS credential store and user service manager, then run Connect again. No connection success was reported.'); if (error && /^Could not complete |^Background agent |^Device setup cancelled|^The previous device agent/.test(error.message)) console.error(error.message); process.exitCode = 1; });
`;
