import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script, runInNewContext } from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const definition = await readFile(new URL('../backend/src/services/agent-connection-setup/bootstrap/device-agent-runtime.ts', import.meta.url), 'utf8');
const source = definition.slice(definition.indexOf('String.raw`') + 11, definition.lastIndexOf('`;'));
function runtime(overrides = {}) {
  const module = { exports: {} };
  runInNewContext(source, { require, module, process, Buffer, URL, AbortSignal, setTimeout, clearTimeout, fetch, console, __filename: '/unused/agent.cjs', __dirname: '/unused', ...overrides });
  return module.exports;
}
test('payload parses and confines approval to HTTPS or exact loopback origins', () => {
  new Script(source);
  const api = runtime();
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=secret']) assert.throws(() => api.origin(url));
  assert.equal(api.origin('https://example.com'), 'https://example.com');
  assert.equal(api.origin('http://127.0.0.1:13500'), 'http://127.0.0.1:13500');
  assert.notEqual(api.identity('https://example.com', 'alice').id, api.identity('https://example.com', 'bob').id);
});
test('service definitions preserve paths without interpreting shell syntax', () => {
  const processFor = platform => Object.defineProperty(Object.create(process), 'platform', { value: platform });
  const mac = runtime({ process: processFor('darwin') });
  const spec = { label: 'ai.archestra.device.example', root: '/tmp/Space & "quoted" path' };
  const plist = mac.serviceDefinition(spec, '/tmp/Node & tools/node');
  assert.match(plist, /Space &amp; &quot;quoted&quot; path/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  const linux = runtime({ process: processFor('linux') });
  assert.match(linux.serviceDefinition({ ...spec, root: '/tmp/%n/$HOME' }, '/bin/node'), /%%n\/\$\$HOME/);
  assert.throws(() => mac.windowsArguments('C:\\bad"path\\agent.cjs'));
});
test('network failures reconnect; permanent revocation removes the saved proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'device-agent-unit-'));
  const actions = [];
  let heartbeats = 0;
  let sessions = 0;
  const mockedRequire = name => name === 'node:child_process' ? { spawnSync: (_file, args) => {
    actions.push(args[0]);
    return { status: 0, stdout: args[0] === 'find-generic-password' ? 'a'.repeat(64) : '' };
  } } : require(name);
  const fakeProcess = Object.create(process);
  Object.defineProperty(fakeProcess, 'platform', { value: 'darwin' });
  const api = runtime({ require: mockedRequire, process: fakeProcess, setTimeout: fn => setTimeout(fn, 0), fetch: async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/mcp-sync')) return Response.json({ installations: [], workerSha256: null });
    if (path.endsWith('/session')) { sessions++; return Response.json({ sessionId: randomUUID() }); }
    if (path.endsWith('/heartbeat')) {
      heartbeats++;
      if (heartbeats === 1) throw new TypeError('network down');
      return Response.json({}, { status: 401 });
    }
    return Response.json({ success: true });
  } });
  try {
    await api.run({ url: 'https://example.com', deviceId: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() }, { root: dir, label: 'test', id: 'test' });
    assert.equal(sessions, 2);
    assert.ok(actions.includes('delete-generic-password'));
    assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).state, 'revoked');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a superseded session preserves the credential and stops reconnecting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'device-agent-unit-'));
  const actions = [];
  const fakeProcess = Object.create(process);
  Object.defineProperty(fakeProcess, 'platform', { value: 'darwin' });
  const api = runtime({ process: fakeProcess, require: name => name === 'node:child_process' ? { spawnSync: (_file, args) => { actions.push(args[0]); return { status: 0, stdout: 'a'.repeat(64) }; } } : require(name), fetch: async () => Response.json({}, { status: 409 }) });
  try {
    await api.run({ url: 'https://example.com', deviceId: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() }, { root: dir, label: 'test', id: 'test' });
    assert.ok(!actions.includes('delete-generic-password'));
    assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).state, 'superseded');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// CI-only native lifecycle: real user service registration and OS credential store.
// No modifications to a developer's login items are needed for the unit coverage.
test('native install, repeat Connect, restart, reconnect, revocation and uninstall', { skip: process.env.DEVICE_AGENT_NATIVE_CI !== '1', timeout: 240000 }, async () => {
  assert.ok(['darwin', 'win32'].includes(process.platform));
  const dir = await mkdtemp(join(tmpdir(), 'device-agent-native-'));
  const payload = join(dir, 'agent.cjs');
  await writeFile(payload, source);
  const token = randomBytes(48).toString('base64url');
  const deviceId = randomUUID();
  let created = 0;
  let sessionId;
  let unavailable = false;
  let revoked = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.url === '/api/local-devices/install') {
      const reuse = req.headers.authorization === 'Bearer ' + token;
      if (!reuse) created++;
      return send(200, { deviceId, name: 'CI computer', token, created: !reuse, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    }
    if (revoked || req.headers.authorization !== 'Bearer ' + token) return send(401, {});
    if (unavailable) return send(503, {});
    if (req.url.endsWith('/mcp-sync')) return send(200, { installations: [], workerSha256: null });
    if (req.url.endsWith('/session')) { sessionId = randomUUID(); return send(200, { sessionId }); }
    if (req.url.endsWith('/heartbeat') && body.sessionId !== sessionId) return send(409, {});
    if (req.url.endsWith('/remove-agent')) revoked = true;
    return send(200, { success: true, name: 'CI computer' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const options = { url, userId: 'device-ci-' + randomUUID(), appName: 'Example AI', code: randomBytes(32).toString('base64url') };
  const api = runtime();
  const spec = api.identity(url, options.userId);
  const installed = join(spec.root, 'agent.cjs');
  const call = (file, action, input) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [file, action], { timeout: 120000, encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(new Error(action + ' failed: ' + stderr)) : resolve(stdout));
    child.stdin.end(input ? JSON.stringify(input) : undefined);
  });
  const waitState = async (expected, newerThan = 0) => {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      const status = JSON.parse(await readFile(join(spec.root, 'status.json'), 'utf8'));
      if (status.state === expected && status.updatedAt >= newerThan) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Agent did not reach ' + expected);
  };
  try {
    assert.match(await call(payload, 'install', options), /Background agent connected/);
    assert.match(await call(payload, 'install', options), /Background agent connected/);
    assert.equal(created, 1, 'repeat Connect must reuse the device');
    await call(installed, 'stop');
    const restarted = Date.now();
    await call(installed, 'start');
    await waitState('online', restarted);
    unavailable = true;
    await waitState('connecting');
    unavailable = false;
    await waitState('online', Date.now());
    revoked = true;
    await waitState('revoked');
    await call(installed, 'uninstall');
    await assert.rejects(readFile(join(spec.root, 'credential.dpapi')), { code: 'ENOENT' });
  } finally {
    try { await call(installed, 'uninstall'); } catch {}
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    await rm(spec.root, { recursive: true, force: true });
  }
});
