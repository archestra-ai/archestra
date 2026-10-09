/** Local helper installed beside the guard. Prepares direct mode and reads native config. */
export const CODEX_HANDOFF_HELPER = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
function codexEntry(executable) {
  const isNpmShim = /\.cmd$/i.test(executable);
  const entry = isNpmShim ? path.join(path.dirname(executable), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : executable;
  if ((isNpmShim && !existsSync(entry)) || /\.ps1$/i.test(entry)) throw new Error('Could not locate the native Codex CLI.');
  return { command: isNpmShim ? process.execPath : entry, args: isNpmShim ? [entry] : [] };
}
function envValue(name) {
  const key = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? process.env[key] : '';
}
function nestedCodexShell() {
  return envValue('CODEX_SANDBOX_NETWORK_DISABLED') && envValue('CODEX_THREAD_ID');
}
function prepareDirectCatalog(executable, clientArgs = [], persist = true) {
  const { command, args } = codexEntry(executable);
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const original = existsSync(path.join(home, 'config.toml')) ? readFileSync(path.join(home, 'config.toml'), 'utf8') : '';
  mkdirSync(home, { recursive: true });
  const shadow = mkdtempSync(path.join(home, '.archestra-codex-models-'));
  const started = Date.now();
  const authFile = path.join(home, 'auth.json');
  let nativeAuth;
  let result;
  try {
    chmodSync(shadow, 0o700);
    const content = restoreManagedConfig(original);
    const lines = content.split(/\r?\n/);
    const scanned = tomlTables(lines);
    assertSingleLineManagedRootValues(lines, scanned);
    const { tables, active } = scanned;
    const rootEnd = tables[0]?.index ?? lines.length;
    for (let i = 0; i < rootEnd; i++) {
      const assignment = active.has(i) ? tomlAssignment(lines[i]) : undefined;
      if (assignment?.key === 'cli_auth_credentials_store') {
        const literal = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(assignment.value)?.[1];
        const store = literal?.startsWith('"') ? JSON.parse(literal) : literal?.slice(1, -1);
        if (store !== 'file') throw new Error('Codex catalog discovery requires file-backed credentials. Keyring and auto credential storage are not supported.');
      }
    }
    for (let i = rootEnd - 1; i >= 0; i--) {
      if (active.has(i) && tomlAssignment(lines[i])?.key === 'model_catalog_json') lines.splice(i, 1);
    }
    writeFileSync(path.join(shadow, 'config.toml'), lines.join('\n'), { mode: 0o600 });
    if (existsSync(authFile)) {
      const shadowAuth = path.join(shadow, 'auth.json');
      // Native Codex saves file credentials in place. Share that inode rather
      // than copying tokens back over a login or logout after discovery.
      // Keep both paths on the same filesystem; linking needs no symlink rights.
      linkSync(authFile, shadowAuth);
      nativeAuth = statSync(shadowAuth, { bigint: true });
      const currentAuth = statSync(authFile, { bigint: true });
      if (currentAuth.dev !== nativeAuth.dev || currentAuth.ino !== nativeAuth.ino) {
        throw new Error('Codex credentials changed during catalog refresh. Retry the launch.');
      }
    }
    // Discovery uses the native provider, not the inference proxy or our own
    // model override. Enabling API-key discovery applies only to this process.
    result = spawnSync(command, [...args, 'debug', 'models', '-c', 'model_provider="openai"', '-c', 'cli_auth_credentials_store="file"', '--enable', 'api_key_model_discovery'], { cwd: shadow, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30000, env: { ...process.env, CODEX_HOME: shadow } });
    if (result.error || result.status !== 0) throw new Error('Could not read the Codex model catalog.');
    // Codex can return the bundled catalog with a successful exit after a network/auth
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
      if (nativeAuth) {
        const currentAuth = existsSync(authFile) ? statSync(authFile, { bigint: true }) : null;
        if (!currentAuth || currentAuth.dev !== nativeAuth.dev || currentAuth.ino !== nativeAuth.ino) {
          throw new Error('Codex credentials changed during catalog refresh. Retry the launch.');
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
    throw modelCompatibilityError(requested, executable, catalog);
  }
  if (!persist) return { home };
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
function modelCompatibilityError(requested, executable, catalog) {
  let version = 'version unavailable';
  if (executable) {
    const entry = codexEntry(executable);
    const result = spawnSync(entry.command, [...entry.args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.status === 0) version = result.stdout.trim().slice(0, 200);
  }
  const available = catalog.models.slice(0, 12).map(model => model.slug).join(', ');
  return new Error('Selected model is missing from the current Codex catalog: ' + JSON.stringify(requested) + ' (' + version + (executable ? '; CLI: ' + executable : '') + '). '
    + 'The desktop app and terminal CLI can expose different catalogs. Update the terminal Codex CLI to a version that supports this model, then rerun setup; or explicitly choose a model supported by that CLI. '
    + 'Catalog models: ' + available + '. Your selected model and permission settings have not been changed. This check does not test LLM proxy inference.');
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
      if (match) tables.push({ index, name: (match[1] === '[[' ? '[' : '') + tomlKey(match[2].trim()) });
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
function tomlKey(text) {
  // A dot inside a quoted key is not a dotted-key separator.
  return [...text.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+/g)].map(match => {
    const key = match[0];
    if (key.startsWith('"')) return JSON.parse(key.replace(/\\(?:U([0-9a-fA-F]{8})|.)/g, (escape, hex) => hex ? JSON.stringify(String.fromCodePoint(parseInt(hex, 16))).slice(1, -1) : escape));
    return key.startsWith("'") ? key.slice(1, -1) : key;
  }).join('\0');
}
function tomlAssignment(line) {
  const match = /^\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=\s*(.*)$/.exec(line);
  return match ? { key: tomlKey(match[1]), value: match[2] } : undefined;
}
function assertSingleLineManagedRootValues(lines, scanned) {
  const rootEnd = scanned.tables[0]?.index ?? lines.length;
  for (let i = 0; i < rootEnd; i++) {
    const assignment = scanned.active.has(i) ? tomlAssignment(lines[i]) : undefined;
    // Managed replacements preserve one source line, not a multiline value.
    if ((assignment?.key === 'web_search' || assignment?.key === 'model_catalog_json') && i + 1 < lines.length && !scanned.active.has(i + 1)) {
      throw new Error('Unsupported multiline Codex ' + assignment.key + ' value; use a single-line string.');
    }
  }
}
function disableInlineCodeMode(value) {
  if (!value.startsWith('{')) throw new Error('Unsupported Codex features value; use a [features] table.');
  let quoted = '';
  let depth = 0;
  let start = 1;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) {
      if (quoted === '"' && char === '\\') { i++; continue; }
      if (char === quoted) quoted = '';
      continue;
    }
    if (char === '"' || char === "'") { quoted = char; continue; }
    if (char === '{' || char === '[') depth++;
    if (char === '}' || char === ']') depth--;
    if ((char === ',' && depth === 1) || (char === '}' && depth === 0)) {
      const entry = value.slice(start, i);
      const assignment = tomlAssignment(entry);
      if (assignment?.key === 'code_mode_host') {
        if (!/^(true|false)\s*$/.test(assignment.value)) throw new Error('Codex code_mode_host must be a boolean.');
        return value.slice(0, start) + entry.replace(/(=\s*)(true|false)(\s*)$/, '$1false$3') + value.slice(i);
      }
      if (depth === 0) {
        const entries = value.slice(1, i).trimEnd();
        return value.slice(0, i) + (entries.trim() && !entries.endsWith(',') ? ',' : '') + ' code_mode_host = false ' + value.slice(i);
      }
      start = i + 1;
    }
  }
  throw new Error('Unsupported multiline Codex features value; use a [features] table.');
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
    if (header) table = header.name;
    const assignment = tomlAssignment(lines[i]);
    const match = assignment && /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(assignment.value);
    if (match && (assignment.key === 'model' || assignment.key === 'profile')) values.set((table ? table + '\0' : '') + assignment.key, unquote(match[1]));
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
      const assignment = tomlAssignment(value || '');
      if (assignment && (assignment.key === 'model' || assignment.key === 'profile' || /^profiles\0[^\0]+\0model$/.test(assignment.key))) {
        const literal = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(assignment.value);
        values.set(assignment.key, literal ? unquote(literal[1]) : assignment.value.trim());
      }
    }
  }
  if (model) return model;
  profile = profile || values.get('profile');
  return (profile && values.get(['profiles', profile, 'model'].join('\0'))) || values.get('model');
}
function reusePreparedDirectCatalog(clientArgs) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const filename = path.join(home, 'archestra-direct-model-catalog.json');
  // A nested verification cannot refresh through a network-blocked sandbox.
  // Reuse only a recent direct catalog; the wrapper still forces its overrides.
  const maxAgeMs = 24 * 60 * 60 * 1000;
  if (!existsSync(filename)) throw new Error('Codex did not fetch a fresh model catalog; check upstream credentials and connectivity.');
  const age = Date.now() - statSync(filename).mtimeMs;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) throw new Error('Codex did not fetch a fresh model catalog; check upstream credentials and connectivity.');
  const original = existsSync(path.join(home, 'config.toml')) ? readFileSync(path.join(home, 'config.toml'), 'utf8') : '';
  let catalog;
  try { catalog = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('Codex returned an invalid model catalog.'); }
  if (catalog.fetched_at != null) {
    const fetched = Date.parse(catalog.fetched_at);
    if (!Number.isFinite(fetched) || Date.now() - fetched > maxAgeMs || fetched > Date.now() + 1000) {
      throw new Error('Codex did not fetch a fresh model catalog; check upstream credentials and connectivity.');
    }
  }
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Codex returned an empty model catalog.');
  if (catalog.models.some(model => typeof model.slug !== 'string' || !model.slug || model.tool_mode !== 'direct' || model.supports_search_tool !== false)) {
    throw new Error('Codex returned an invalid model catalog.');
  }
  const requested = requestedModel(clientArgs, original);
  const unnamespaced = requested && requested.replace(/^[A-Za-z0-9_-]+\/([^/]+)$/, '$1');
  if (requested && !catalog.models.some(model => requested.startsWith(model.slug) || unnamespaced.startsWith(model.slug))) {
    throw modelCompatibilityError(requested, undefined, catalog);
  }
  return { home, filename };
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
  assertSingleLineManagedRootValues(lines, scanned);
  const existingTables = scanned.tables;
  const rootEnd = existingTables[0]?.index ?? lines.length;
  const rootAssignments = lines.slice(0, rootEnd).flatMap((line, i) => {
    const assignment = scanned.active.has(i) ? tomlAssignment(line) : undefined;
    return assignment ? [assignment] : [];
  });
  const inlineFeatures = rootAssignments.find(assignment => assignment.key === 'features');
  const dottedFeatures = rootAssignments.some(assignment => assignment.key.startsWith('features\0'));
  const hasFeaturesTable = existingTables.some(table => table.name === 'features');
  const sections = [
    { name: '', values: { web_search: '"disabled"', model_catalog_json: JSON.stringify(filename),
      ...(inlineFeatures ? { features: disableInlineCodeMode(inlineFeatures.value) } : {}),
      ...(dottedFeatures && !hasFeaturesTable ? { 'features.code_mode_host': 'false' } : {}) }, marker: 'root' },
    ...(!inlineFeatures && (!dottedFeatures || hasFeaturesTable) ? [{ name: 'features', values: { code_mode_host: 'false' }, marker: 'features' }] : []),
  ];
  for (const section of sections) {
    const { tables, active } = tomlTables(lines);
    const start = section.name ? (tables.find(table => table.name === section.name)?.index ?? -1) : -1;
    const from = section.name ? (start < 0 ? lines.length : start + 1) : 0;
    let end = tables.find(table => table.index >= from)?.index ?? lines.length;
    const keys = Object.keys(section.values);
    const originals = [];
    for (let i = end - 1; i >= from; i--) {
      if (active.has(i) && keys.some(key => tomlAssignment(lines[i])?.key === key.split('.').join('\0'))) {
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
if (process.argv[2] === '--setup-only') {
  // Gateway/skills-only setup does not require model discovery.
} else if (process.argv[2] === '--remove-direct') {
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
} else if (process.argv[2] === '--preflight') {
  try { prepareDirectCatalog(process.argv[3], [], false); }
  catch (error) {
    process.stderr.write('Codex setup preflight failed: ' + error.message + '\nNo client configuration was changed. Fix the compatibility or credential problem and start a new installer run.\n');
    process.exitCode = 1;
  }
} else if (process.argv[2] === '--direct' || process.argv[2] === '--install-direct') {
  try {
    const clientArgs = process.argv.slice(4).filter(arg => arg !== '--output-base64');
    const { home, filename } = process.argv[2] === '--direct' && nestedCodexShell()
      ? reusePreparedDirectCatalog(clientArgs)
      : prepareDirectCatalog(process.argv[3], clientArgs);
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
