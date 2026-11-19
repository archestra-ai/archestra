import { GROK_TOML } from "./grok-toml.generated";
import { MARKETPLACE_SKILLS_SYNC } from "./marketplace-skills-sync";

export const GROK_LEGACY_PLUGINS = String.raw`${MARKETPLACE_SKILLS_SYNC}
function removeLegacyGrokPlugins({ home, privateRoot }) {
  ${GROK_TOML}
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), equal = require("node:util").isDeepStrictEqual;
  const stateFile = path.join(privateRoot, "skills.json"), registryFile = path.join(home, "installed-plugins/registry.json"), journalFile = path.join(privateRoot, "legacy-plugin-removal.json"), config = path.join(home, "config.toml"), scopes = path.join(privateRoot, "skill-scopes");
  const safe = file => {
    for (let current = path.resolve(file); ; current = path.dirname(current)) {
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || (current.startsWith(require("node:os").homedir() + path.sep) && process.getuid && stat.uid !== process.getuid()))) throw new Error("Grok shared plugins refuse linked or unowned paths.");
      if (path.dirname(current) === current) break;
    }
  };
  const read = file => { safe(file); return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null; };
  const json = file => { const value = read(file); return value === null ? null : JSON.parse(value); };
  const write = (file, content, expected) => {
    safe(file);
    if (expected !== undefined && read(file) !== expected) throw new Error("Grok settings changed concurrently; private recovery was preserved.");
    if (content === null) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
    const temporary = file + "." + crypto.randomUUID() + ".tmp";
    try { fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" }); if (expected !== undefined && read(file) !== expected) throw new Error("Grok settings changed concurrently; private recovery was preserved."); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  const digest = directory => {
    const files = {};
    const collect = folder => { safe(folder); for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name); safe(file);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files[path.relative(directory, file)] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      else throw new Error("Unsupported Grok plugin file.");
    } };
    collect(directory);
    return JSON.stringify(Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))));
  };
  const matches = name => Object.values(json(registryFile)?.repos || {}).filter(entry => Object.keys(entry.plugins || {}).some(key => key.toLowerCase() === name.toLowerCase()));
  const validate = plugins => { for (const [name, owned] of Object.entries(plugins)) {
    const entries = matches(name);
    if (entries.length !== 1 || !Object.hasOwn(entries[0].plugins, name) || entries[0].kind?.type !== "Local" || entries[0].kind.source_path !== owned.source || entries[0].path !== owned.path || !owned.path.startsWith(path.join(home, "installed-plugins") + path.sep) || digest(owned.path) !== owned.digest) throw new Error("Managed Grok plugin changed; recorded data and registrations were preserved.");
    if (owned.staged && digest(owned.source) !== owned.sourceDigest) throw new Error("Managed Grok plugin source changed; recorded data was preserved.");
  } };
  const removeEnabled = (text, name) => {
    if (text === null) return null;
    const parsed = grokNativePluginConfiguration(text);
    return parsed.enabled ? text.slice(0, parsed.enabled.start) + JSON.stringify(parsed.enabled.values.filter(value => value !== name)) + text.slice(parsed.enabled.end) : text;
  };
  const parseConfig = text => grokToml.parse((text || "").replace(/^\uFEFF/, ""), { integersAsBigInt: "asNeeded" });
  const merge = (base, desired, current, keys = []) => {
    if (equal(base, desired) || equal(current, desired) || desired === undefined) return current;
    if (keys.join(".") === "plugins.enabled" && Array.isArray(current)) return current;
    if (base && desired && current && [base, desired, current].every(value => typeof value === "object" && !Array.isArray(value))) {
      const result = { ...current };
      for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
        const value = merge(base[key], desired[key], current[key], [...keys, key]);
        if (value === undefined) delete result[key]; else result[key] = value;
      }
      return result;
    }
    if (base === undefined && current === undefined) return desired;
    throw new Error("Grok settings conflict with pending plugin removal; private recovery and current settings were preserved.");
  };
  const contains = (current, expected, keys = []) => {
    if (equal(current, expected)) return true;
    if (keys.join(".") === "plugins.enabled" && Array.isArray(current) && Array.isArray(expected)) return expected.every(value => current.includes(value));
    return current && expected && typeof current === "object" && typeof expected === "object" && !Array.isArray(current) && !Array.isArray(expected) && Object.keys(expected).every(key => contains(current[key], expected[key], [...keys, key]));
  };
  const afterOwnership = (before, plugins) => Object.keys(plugins).length ? { ...before, plugins } : { home, source: null, scope: null, plugins };
  safe(journalFile); safe(path.join(home, "plugins")); safe(scopes);
  fs.mkdirSync(scopes, { recursive: true, mode: 0o700 });
  let previous = json(stateFile) || { home, plugins: {} };
  if (previous.home !== home) throw new Error("GROK_HOME differs from the recorded plugin profile; existing data was preserved.");
  const complete = journal => {
    if (journal.format !== 1 || journal.home !== home || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(journal.name) || !journal.beforeState || !journal.afterState || journal.beforeState.home !== home || !equal(journal.beforeState.plugins?.[journal.name], journal.owned)) throw new Error("Legacy plugin removal recovery identity is invalid.");
    const plugins = { ...journal.beforeState.plugins }; delete plugins[journal.name];
    if (!equal(journal.afterState, afterOwnership(journal.beforeState, plugins)) || (journal.scope !== null && !/^[a-f0-9]{32}$/.test(journal.scope)) || journal.scope !== (journal.beforeState.scope || (journal.beforeState.source ? marketplaceSkillsIdentity(journal.beforeState.source).scope : null))) throw new Error("Legacy plugin removal recovery ownership is invalid.");
    const stateText = read(stateFile), currentState = stateText === null ? null : JSON.parse(stateText), scopeFile = journal.scope ? path.join(scopes, journal.scope + ".json") : null, scopeText = scopeFile ? read(scopeFile) : null, currentScope = scopeText === null ? null : JSON.parse(scopeText), afterScope = { home, scope: journal.scope, plugins };
    if (!equal(currentState, journal.beforeState) && !equal(currentState, journal.afterState)) throw new Error("Legacy plugin ownership changed concurrently; recovery was preserved.");
    if (scopeFile && !equal(currentScope, journal.beforeScope) && !equal(currentScope, afterScope)) throw new Error("Legacy plugin scope changed concurrently; recovery was preserved.");
    if (matches(journal.name).length) { validate({ [journal.name]: journal.owned }); return false; }
    validate(plugins);
    const current = read(config), desired = removeEnabled(journal.beforeConfig, journal.name);
    let content;
    if ([journal.beforeConfig, desired].includes(current)) content = desired;
    else {
      const desiredDocument = parseConfig(desired), currentDocument = parseConfig(current);
      if (journal.nativeAfter === undefined && !contains(currentDocument, desiredDocument)) throw new Error("Native removal completed before its config checkpoint; preserve the private journal and reconcile local settings. No registry was overwritten.");
      const document = journal.nativeAfter === undefined ? currentDocument : merge(parseConfig(journal.nativeAfter), desiredDocument, currentDocument);
      if (Array.isArray(document.plugins?.enabled)) document.plugins.enabled = document.plugins.enabled.filter(value => value !== journal.name);
      content = equal(document, desiredDocument) ? desired : equal(document, currentDocument) ? removeEnabled(current, journal.name) : grokToml.stringify(document);
    }
    if (content !== current) write(config, content, current);
    if (scopeFile && !equal(currentScope, afterScope)) write(scopeFile, JSON.stringify(afterScope), scopeText);
    if (!equal(currentState, journal.afterState)) write(stateFile, JSON.stringify(journal.afterState), stateText);
    safe(journalFile); fs.unlinkSync(journalFile);
    previous = journal.afterState;
    return true;
  };
  const pending = json(journalFile);
  if (pending && !complete(pending)) {
    if (read(config) !== pending.beforeConfig) throw new Error("Interrupted native removal has unresolved settings; private recovery was preserved.");
    fs.unlinkSync(journalFile);
  }
  validate(previous.plugins);
  for (const name of Object.keys(previous.plugins)) {
    const scope = previous.scope || (previous.source ? marketplaceSkillsIdentity(previous.source).scope : null);
    if (scope !== null && !/^[a-f0-9]{32}$/.test(scope)) throw new Error("Grok legacy plugin scope identity is invalid.");
    const scopeFile = scope ? path.join(scopes, scope + ".json") : null, beforeScope = scopeFile ? json(scopeFile) : null;
    if (beforeScope && !equal(beforeScope, { home, scope, plugins: previous.plugins })) throw new Error("Grok skills scope snapshot changed; existing state was preserved.");
    const plugins = { ...previous.plugins }; delete plugins[name];
    const journal = { format: 1, home, name, owned: previous.plugins[name], scope, beforeScope, beforeState: previous, afterState: afterOwnership(previous, plugins), beforeConfig: read(config) };
    parseConfig(journal.beforeConfig);
    write(journalFile, JSON.stringify(journal));
    let failed = false;
    try { require("node:child_process").execFileSync("grok", ["plugin", "uninstall", name, "--confirm", "--keep-data"], { env: { ...process.env, GROK_HOME: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }); }
    catch { failed = true; }
    journal.nativeAfter = read(config);
    if (matches(name).length) {
      validate({ [name]: journal.owned });
      if (journal.nativeAfter !== journal.beforeConfig) write(config, journal.beforeConfig, journal.nativeAfter);
      fs.unlinkSync(journalFile);
      throw new Error("Grok native plugin removal failed. The original configuration was restored; native credentials were not removed.");
    }
    write(journalFile, JSON.stringify(journal));
    try { complete(journal); }
    catch {
      const current = read(config);
      if (current === journal.nativeAfter && current !== journal.beforeConfig) { try { write(config, journal.beforeConfig, current); } catch {} }
      throw new Error("Native plugin removal needs recovery. Its private journal and unrelated registrations were preserved; run setup or sync again.");
    }
    if (failed) throw new Error("Native plugin removal completed with a native process error; ownership was reconciled without changing unrelated registrations.");
  }
}
function grokNativePluginConfiguration(text) {
  const lines = text.split(/(?<=\n)/);
  let quoted = "", root = true, plugins = false, position = 0, enabled = null, insertion = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!quoted) {
      const header = /^\s*(\[\[?)([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line.trimEnd());
      if (header) {
        root = false;
        const name = header[2].trim();
        plugins = /^(?:plugins|"plugins"|'plugins')$/.test(name);
        if (plugins) {
          if (insertion !== null) throw new Error("Duplicate Grok plugin configuration table.");
          insertion = position + line.length;
        }
      } else if (root && /^\s*(?:plugins|"plugins"|'plugins')\s*(?:=|\.)/.test(line)) throw new Error("Grok plugin settings use an inline or dotted root table. Preserve that configuration and expand it to a [plugins] table before installing plugins.");
      else if (plugins) {
        const assignment = /^\s*(?:enabled|"enabled"|'enabled')\s*=\s*/.exec(line);
        if (assignment) {
          if (enabled) throw new Error("Duplicate Grok plugin enabled setting.");
          const start = position + assignment[0].length;
          enabled = { start, ...grokNativeEnabledArray(text, start) };
        }
      }
    }
    for (let offset = 0; offset < line.length; offset++) {
      const triple = line.slice(offset, offset + 3);
      if (quoted.length === 3) {
        if (quoted === '"""' && line[offset] === "\\") { offset++; continue; }
        if (triple === quoted) { quoted = ""; offset += 2; }
      } else if (quoted) {
        if (quoted === '"' && line[offset] === "\\") { offset++; continue; }
        if (line[offset] === quoted) quoted = "";
      } else if (line[offset] === "#") break;
      else if (triple === '"""' || triple === "'''") { quoted = triple; offset += 2; }
      else if (line[offset] === '"' || line[offset] === "'") quoted = line[offset];
    }
    if (quoted.length === 1) quoted = "";
    position += line.length;
  }
  return { enabled, insertion };
}
function grokNativeEnabledArray(text, start) {
  let offset = start;
  const whitespace = () => {
    while (offset < text.length) {
      if (/\s/.test(text[offset])) offset++;
      else if (text[offset] === "#") { while (offset < text.length && text[offset] !== "\n") offset++; }
      else break;
    }
  };
  const invalid = () => { throw new Error("Grok plugin enabled setting must be an array of quoted plugin names."); };
  if (text[offset++] !== "[") invalid();
  const values = [];
  whitespace();
  while (text[offset] !== "]") {
    const quote = text[offset++];
    if (quote !== '"' && quote !== "'") invalid();
    const begin = offset;
    while (offset < text.length && text[offset] !== quote) {
      if (text[offset] === "\n" || text[offset] === "\r") invalid();
      if (quote === '"' && text[offset] === "\\") offset++;
      offset++;
    }
    if (offset >= text.length) invalid();
    const raw = text.slice(begin, offset++);
    values.push(quote === '"' ? JSON.parse('"' + raw + '"') : raw);
    whitespace();
    if (text[offset] === "]") break;
    if (text[offset++] !== ",") invalid();
    whitespace();
  }
  return { end: offset + 1, values };
}
`;
