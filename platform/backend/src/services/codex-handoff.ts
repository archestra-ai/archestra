/** Local helper installed beside the guard. Prepares direct mode and reads native config. */
export const CODEX_HANDOFF_HELPER = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
function codexEntry(executable) {
  const isNpmShim = /\.cmd$/i.test(executable);
  const entry = isNpmShim ? path.join(path.dirname(executable), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : executable;
  if ((isNpmShim && !existsSync(entry)) || /\.ps1$/i.test(entry)) throw new Error('Could not locate the native Codex CLI.');
  return { command: isNpmShim ? process.execPath : entry, args: isNpmShim ? [entry] : [] };
}
function prepareDirectCatalog(executable, clientArgs = []) {
  const { command, args } = codexEntry(executable);
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const original = existsSync(path.join(home, 'config.toml')) ? readFileSync(path.join(home, 'config.toml'), 'utf8') : '';
  const shadow = mkdtempSync(path.join(os.tmpdir(), 'archestra-codex-models-'));
  const started = Date.now();
  const authFile = path.join(home, 'auth.json');
  const authBefore = existsSync(authFile) ? readFileSync(authFile) : null;
  let result;
  try {
    chmodSync(shadow, 0o700);
    const content = restoreManagedConfig(original);
    const lines = content.split(/\r?\n/);
    const { tables, active } = tomlTables(lines);
    const rootEnd = tables[0]?.index ?? lines.length;
    for (let i = rootEnd - 1; i >= 0; i--) {
      if (active.has(i) && /^\s*model_catalog_json\s*=/.test(lines[i])) lines.splice(i, 1);
    }
    writeFileSync(path.join(shadow, 'config.toml'), lines.join('\n'), { mode: 0o600 });
    if (authBefore) {
      const shadowAuth = path.join(shadow, 'auth.json');
      writeFileSync(shadowAuth, authBefore, { mode: 0o600 });
    }
    // Discovery uses the native provider, not the inference proxy or our own
    // model override. Enabling API-key discovery applies only to this process.
    result = spawnSync(command, [...args, 'debug', 'models', '-c', 'model_provider="openai"', '--enable', 'api_key_model_discovery'], { cwd: shadow, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30000, env: { ...process.env, CODEX_HOME: shadow } });
    if (result.error || result.status !== 0) throw new Error('Could not read the Codex model catalog.');
    // Codex can return the bundled catalog with exit 0 after a network/auth
    // failure. A newly written cache is evidence of an actual remote refresh.
    const cacheFile = path.join(shadow, 'models_cache.json');
    const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null;
    // The cache did not exist before this process. Allow a small wall-clock
    // adjustment between Node and Codex without accepting an old cached result.
    if (!cache || !Number.isFinite(Date.parse(cache.fetched_at)) || Date.parse(cache.fetched_at) < started - 1000) {
      throw new Error('Codex did not fetch a fresh model catalog; check upstream credentials and connectivity.');
    }
  } finally {
    try {
      // Codex may rotate OAuth tokens during discovery. Do not discard them
      // with the scratch home, or overwrite a concurrent login/logout.
      const shadowAuth = path.join(shadow, 'auth.json');
      if (authBefore && existsSync(shadowAuth)) {
        const refreshed = readFileSync(shadowAuth);
        if (!refreshed.equals(authBefore)) {
          if (!existsSync(authFile) || !readFileSync(authFile).equals(authBefore)) {
            throw new Error('Codex credentials changed during catalog refresh; retry the launch.');
          }
          JSON.parse(refreshed.toString('utf8'));
          const tempAuth = authFile + '.archestra-' + process.pid;
          try {
            writeFileSync(tempAuth, refreshed, { mode: 0o600 });
            renameSync(tempAuth, authFile);
          } finally { rmSync(tempAuth, { force: true }); }
        }
      }
    } finally { rmSync(shadow, { recursive: true, force: true }); }
  }
  const catalog = JSON.parse(result.stdout);
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Codex returned an empty model catalog.');
  if (catalog.models.some(model => typeof model.slug !== 'string' || !model.slug)) throw new Error('Codex returned an invalid model catalog.');
  const requested = requestedModel(clientArgs, original);
  const unnamespaced = requested?.replace(/^[A-Za-z0-9_-]+\/([^/]+)$/, '$1');
  if (requested && !catalog.models.some(model => requested.startsWith(model.slug) || unnamespaced.startsWith(model.slug))) {
    throw new Error('Selected model is missing from the current Codex catalog.');
  }
  for (const model of catalog.models) {
    model.tool_mode = 'direct';
    model.supports_search_tool = false;
  }
  mkdirSync(home, { recursive: true });
  const filename = path.join(home, 'archestra-direct-model-catalog.json');
  const temporary = filename + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 });
    renameSync(temporary, filename);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { home, filename };
}
function tomlTables(lines) {
  const tables = [];
  const active = new Set();
  let quoted = '';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!quoted) {
      active.add(index);
      const match = /^\s*(\[\[?)([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
      if (match) tables.push({ index, name: match[1] === '[[' ? '[' + match[2].trim() : match[2].trim() });
    }
    for (let i = 0; i < line.length; i++) {
      const next = line.slice(i, i + 3);
      if (quoted === '"""' || quoted === "'''") {
        if (quoted === '"""' && line[i] === '\\') { i++; continue; }
        if (next === quoted) { quoted = ''; i += 2; }
      } else if (quoted) {
        if (quoted === '"' && line[i] === '\\') { i++; continue; }
        if (line[i] === quoted) quoted = '';
      } else if (line[i] === '#') {
        break;
      } else if (next === '"""' || next === "'''") {
        quoted = next;
        i += 2;
      } else if (line[i] === '"' || line[i] === "'") {
        quoted = line[i];
      }
    }
    if (quoted === '"' || quoted === "'") quoted = '';
  }
  return { tables, active };
}
function restoreManagedConfig(original) {
  let content = original;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  for (const block of ['root', 'features', 'tools']) {
    const start = '# >>> archestra:codex-direct:' + block + ' >>>';
    const end = '# <<< archestra:codex-direct:' + block + ' <<<';
    content = content.replace(new RegExp('^' + start + '[\\s\\S]*?^' + end + '\\r?\\n?', 'gm'), match =>
      match.split(/\r?\n/).filter(line => line.startsWith('# original: ')).map(line => line.slice(12) + newline).join(''));
  }
  return content;
}
function requestedModel(args, config) {
  const unquote = value => value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1);
  const values = new Map();
  const lines = config.split(/\r?\n/);
  const { tables, active } = tomlTables(lines);
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    if (!active.has(i)) continue;
    const header = tables.find(header => header.index === i);
    if (header) table = header.name.replace(/['"]/g, '');
    const match = /^\s*(model|profile)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(lines[i]);
    if (match) values.set((table ? table + '.' : '') + match[1], unquote(match[2]));
  }
  let model;
  let profile = values.get('profile');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break;
    if (args[i] === '-m' || args[i] === '--model') model = args[++i];
    else if (args[i].startsWith('--model=')) model = args[i].slice(8);
    else if (args[i] === '-p' || args[i] === '--profile') profile = args[++i];
    else if (args[i].startsWith('--profile=')) profile = args[i].slice(10);
    else if (args[i] === '-c' || args[i] === '--config' || args[i].startsWith('--config=')) {
      const value = args[i].startsWith('--config=') ? args[i].slice(9) : args[++i];
      const match = /^\s*((?:profiles\.[\w-]+\.)?model|profile)\s*=\s*(.*?)\s*$/.exec(value || '');
      if (match) values.set(match[1], /^['"]/.test(match[2]) ? unquote(match[2]) : match[2]);
    }
  }
  if (model) return model;
  profile = profile || values.get('profile');
  return (profile && values.get('profiles.' + profile + '.model')) || values.get('model');
}
function updateDirectConfig(home, filename) {
  const file = path.join(home, 'config.toml');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let content = restoreManagedConfig(original);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  if (!filename) {
    const temporary = file + '.archestra-direct-' + process.pid;
    try {
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return;
  }
  const lines = content.split(/\r?\n/);
  const scanned = tomlTables(lines);
  const existingTables = scanned.tables;
  const rootEnd = existingTables[0]?.index ?? lines.length;
  const dottedFeatures = lines.slice(0, rootEnd).some((line, i) => scanned.active.has(i) && /^\s*features\.[\w-]+\s*=/.test(line));
  const hasFeaturesTable = existingTables.some(table => table.name === 'features');
  const sections = [
    { name: '', values: { web_search: '"disabled"', model_catalog_json: JSON.stringify(filename),
      ...(dottedFeatures && !hasFeaturesTable ? { 'features.code_mode_host': 'false' } : {}) }, marker: 'root' },
    ...(!dottedFeatures || hasFeaturesTable ? [{ name: 'features', values: { code_mode_host: 'false' }, marker: 'features' }] : []),
  ];
  for (const section of sections) {
    const { tables, active } = tomlTables(lines);
    const start = section.name ? (tables.find(table => table.name === section.name)?.index ?? -1) : -1;
    const from = section.name ? (start < 0 ? lines.length : start + 1) : 0;
    let end = tables.find(table => table.index >= from)?.index ?? lines.length;
    const keys = Object.keys(section.values);
    const originals = [];
    for (let i = end - 1; i >= from; i--) {
      if (active.has(i) && keys.some(key => new RegExp('^\\s*' + key.replaceAll('.', '\\.') + '\\s*=').test(lines[i]))) {
        originals.unshift('# original: ' + lines[i]);
        lines.splice(i, 1);
        end--;
      }
    }
    const marker = 'archestra:codex-direct:' + section.marker;
    const managed = ['# >>> ' + marker + ' >>>', ...originals,
      ...(start < 0 && section.name ? ['[' + section.name + ']'] : []),
      ...Object.entries(section.values).map(([key, value]) => key + ' = ' + value),
      '# <<< ' + marker + ' <<<'];
    lines.splice(section.name ? (start < 0 ? lines.length : start + 1) : end, 0, ...managed);
  }
  const temporary = file + '.archestra-direct-' + process.pid;
  try {
    writeFileSync(temporary, lines.join(newline).replace(/\r?\n*$/, '') + newline, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
if (process.argv[2] === '--remove-direct') {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const configFile = path.join(home, 'config.toml');
    if (existsSync(configFile)) updateDirectConfig(home);
    const catalog = path.join(home, 'archestra-direct-model-catalog.json');
    const config = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
    if (!config.includes(catalog) && !config.includes(JSON.stringify(catalog))) rmSync(catalog, { force: true });
  } catch (error) {
    process.stderr.write('Codex direct tool mode could not be removed: ' + error.message + '\n');
    process.exitCode = 1;
  }
} else if (process.argv[2] === '--direct' || process.argv[2] === '--install-direct') {
  try {
    const { home, filename } = prepareDirectCatalog(process.argv[3], process.argv.slice(4).filter(arg => arg !== '--output-base64'));
    if (process.argv[2] === '--install-direct') updateDirectConfig(home, filename);
    const config = 'model_catalog_json=' + JSON.stringify(filename);
    if (process.argv[2] === '--direct') process.stdout.write(process.argv[4] === '--output-base64' ? Buffer.from(config).toString('base64') : config);
  } catch (error) {
    process.stderr.write('Codex direct tool mode could not be prepared: ' + error.message + '\n');
    process.exitCode = 1;
  }
} else if (process.argv[2] === '--launch') {
  // PowerShell 5.1 passes a quoted TOML override through npm's .cmd shim as
  // multiple words. Bypass the shell/shim and give the CLI its exact argv.
  let args;
  try {
    args = JSON.parse(Buffer.from(process.env.ARCHESTRA_CODEX_LAUNCH_ARGS, 'base64').toString('utf8'));
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Invalid arguments');
  } catch {
    process.stderr.write('Could not prepare Codex launch arguments.\n');
    process.exit(125);
  }
  const executable = process.argv[3];
  if (typeof executable !== 'string' || !executable) {
    process.stderr.write('Could not find the Codex executable.\n');
    process.exit(125);
  }
  let target;
  try { target = codexEntry(executable); }
  catch {
    process.stderr.write('Codex handoff skipped: could not locate the native CLI behind its shim.\n');
    process.exit(125);
  }
  const env = { ...process.env };
  delete env.ARCHESTRA_CODEX_LAUNCH_ARGS;
  delete env.ARCHESTRA_CODEX_LAUNCH_MARKER;
  const child = spawn(target.command, [...target.args, ...args], { stdio: 'inherit', env, windowsHide: true });
  let spawnFailed = false;
  child.on('spawn', () => {
    if (process.env.ARCHESTRA_CODEX_LAUNCH_MARKER) {
      writeFileSync(process.env.ARCHESTRA_CODEX_LAUNCH_MARKER, '', { flag: 'wx' });
    }
  });
  child.on('error', error => { spawnFailed = true; process.stderr.write(error.message + '\n'); process.exitCode = 125; });
  child.on('exit', (code, signal) => { if (!spawnFailed) process.exitCode = code ?? (signal ? 1 : 125); });
} else {
const args = process.argv.slice(3);
const base64Output = args[0] === '--output-base64';
if (base64Output) args.shift();
// Model selection does not change instruction layering. Other overrides belong
// to the caller; do not resolve a different profile, directory, or remote.
let overridden = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--') break;
  if (arg === '-c' || arg === '--config' || arg.startsWith('--config=') || /^-c.+/.test(arg)) {
    const value = arg === '-c' || arg === '--config' ? args[++i] : arg.startsWith('--config=') ? arg.slice(9) : arg.slice(2);
    if (!/^(model|model_provider|model_reasoning_effort)\s*=/.test(value || '')) overridden = true;
  } else if (/^(?:-C|-p|--cd|--profile|--remote|--ignore-user-config)(?:=|$)/.test(arg) || /^-[Cp].+/.test(arg)) overridden = true;
}
if (overridden) {
  process.stderr.write('Runtime handoff instructions skipped: explicit Codex configuration takes precedence.\n');
  process.exit(0);
}
let prompt;
try { prompt = readFileSync(process.argv[2], 'utf8'); }
catch { process.exit(0); }
// Windows npm installs expose codex.cmd. Only this fixed command enters the shell.
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: process.platform === 'win32' });
let finished = false;
const timer = setTimeout(() => finish(), 3000);
function finish(value) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (value !== undefined) {
    const output = 'developer_instructions=' + JSON.stringify(value);
    process.stdout.write(base64Output ? Buffer.from(output, 'utf8').toString('base64') : output);
  }
  else process.stderr.write('Runtime handoff instructions skipped: could not read Codex configuration.\n');
  child.stdin.destroy();
  child.stdout.destroy();
  child.kill();
  child.unref();
}
function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
child.on('error', () => finish());
child.on('exit', () => finish());
child.stdin.on('error', () => finish());
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  try {
    const reply = JSON.parse(line);
    if (reply.id === 1) {
      if (reply.error) return finish();
      send({ method: 'initialized' });
      send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd: process.cwd() } });
    } else if (reply.id === 2) {
      const config = reply.result?.config;
      if (reply.error || !config || typeof config !== 'object') return finish();
      const existing = config.developer_instructions;
      if (existing != null && typeof existing !== 'string') return finish();
      finish(existing ? existing + '\n\n' + prompt : prompt);
    }
  } catch { finish(); }
});
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'archestra_connection', version: '1.0.0' } } });
}
`;
