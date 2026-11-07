import { GROK_LEGACY_PLUGINS } from "./grok-legacy-plugins";

export const GROK_SKILLS = `${GROK_LEGACY_PLUGINS}
function syncGrokSkills({ source, home, privateRoot, install = false }) {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
  if (source?.pluginNames?.length) throw new Error("Grok connections deliver native skills only; plugins are not supported.");
  const nativeHome = path.join(privateRoot, "native"), root = path.join(nativeHome, "skills"), stateFile = path.join(privateRoot, "native-skills.json"), journalFile = path.join(privateRoot, "native-skills-update.json");
  const safe = file => {
    const base = path.resolve(require("node:os").homedir());
    if (!path.resolve(file).startsWith(base + path.sep)) throw new Error("Native skills must stay inside the user home.");
    for (let current = path.resolve(file); ; current = path.dirname(current)) {
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || (current.startsWith(base + path.sep) && process.getuid && stat.uid !== process.getuid()))) throw new Error("Native skills refuse linked or unowned paths.");
      if (path.dirname(current) === current) break;
    }
  };
  const digest = directory => {
    safe(directory);
    if (!fs.existsSync(directory)) return null;
    const files = {};
    const walk = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name); safe(file);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && fs.statSync(file).nlink === 1) files[path.relative(directory, file)] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        else throw new Error("Native skills refuse links and unsupported files.");
      }
    };
    walk(directory);
    return JSON.stringify(Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))));
  };
  const write = (file, value) => {
    safe(file); const temporary = file + "." + crypto.randomUUID() + ".tmp";
    try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  const readState = () => {
    safe(stateFile);
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { format: 1, home: nativeHome, skills: {}, source: null };
    if (state.format !== 1 || state.home !== nativeHome || !state.skills || typeof state.skills !== "object" || Array.isArray(state.skills)) throw new Error("Native skills ownership is not recognized; existing data was preserved.");
    for (const [name, hash] of Object.entries(state.skills)) if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(name) || typeof hash !== "string") throw new Error("Native skill ownership contains an invalid path.");
    return state;
  };
  safe(root); safe(journalFile); safe(path.join(privateRoot, "skills.json")); safe(path.join(privateRoot, "legacy-plugin-removal.json"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let previous = readState();
  if (fs.existsSync(journalFile)) {
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    if (journal.format !== 1 || journal.home !== nativeHome || !Array.isArray(journal.entries) || !journal.beforeState || journal.beforeState.home !== nativeHome || !journal.afterState || journal.afterState.home !== nativeHome || !journal.beforeState.skills || !journal.afterState.skills || new Set(journal.entries.map(entry => entry.name)).size !== journal.entries.length) throw new Error("Native skills recovery identity is invalid.");
    const committed = JSON.stringify(previous) === JSON.stringify(journal.afterState);
    if (!committed && JSON.stringify(previous) !== JSON.stringify(journal.beforeState)) throw new Error("Native skills ownership changed during recovery; existing data was preserved.");
    for (const entry of journal.entries) {
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.name) || entry.backup !== path.join(root, ".backup-" + entry.name) || entry.staged !== path.join(root, ".staged-" + entry.name)) throw new Error("Native skills recovery path is invalid.");
      if (entry.before !== (journal.beforeState.skills[entry.name] || null) || entry.after !== (journal.afterState.skills[entry.name] || null)) throw new Error("Native skills recovery hashes differ from the recorded ownership.");
      for (const file of [entry.backup, entry.staged]) safe(file);
      const target = path.join(root, entry.name), current = digest(target);
      if (current !== entry.before && current !== entry.after && current !== null) throw new Error("Native skills changed during recovery; private backups were preserved.");
      if (digest(entry.backup) !== null && digest(entry.backup) !== entry.before) throw new Error("Native skills recovery backup changed.");
      if (committed && current !== entry.after || !committed && current !== entry.before && entry.before !== null && digest(entry.backup) !== entry.before) throw new Error("Native skills recovery generation is incomplete; backups were preserved.");
    }
    for (const entry of journal.entries) {
      const target = path.join(root, entry.name);
      if (!committed && digest(target) !== entry.before) {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
        if (fs.existsSync(entry.backup)) fs.renameSync(entry.backup, target);
        else if (entry.before !== null) throw new Error("Native skills recovery backup is missing.");
      }
      for (const file of [entry.backup, entry.staged]) if (fs.existsSync(file)) fs.rmSync(file, { recursive: true });
    }
    fs.unlinkSync(journalFile);
  }
  for (const [name, hash] of Object.entries(previous.skills)) if (digest(path.join(root, name)) !== hash) throw new Error("A managed native skill differs from its recorded content; edited files were preserved.");
  const desired = {};
  if (source && source.hasSkills !== false) {
    const directory = syncMarketplaceSkills({ source, install });
    if (directory) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(entry.name)) throw new Error("Invalid native skill directory.");
      const skill = path.join(directory, entry.name); safe(skill);
      if (!fs.existsSync(path.join(skill, "SKILL.md"))) throw new Error("A native skill requires SKILL.md.");
      for (const manifest of [".claude-plugin/plugin.json", ".grok-plugin/plugin.json"]) if (fs.existsSync(path.join(skill, manifest))) throw new Error("Grok connections require standalone native skills, not plugin packages. Publish the SKILL.md directory and its resources instead.");
      const hash = digest(skill);
      desired[entry.name] = { directory: skill, hash };
    }
  }
  const disk = fs.readdirSync(root).filter(name => !name.startsWith("."));
  for (const [name] of Object.entries(desired)) if (disk.some(existing => existing.toLowerCase() === name.toLowerCase() && !Object.hasOwn(previous.skills, existing))) throw new Error("An unmanaged native skill already uses this name; no files were overwritten.");
  const entries = [];
  const afterState = { format: 1, home: nativeHome, source, skills: Object.fromEntries(Object.entries(desired).map(([name, value]) => [name, value.hash])) };
  for (const name of new Set([...Object.keys(previous.skills), ...Object.keys(desired)])) {
    const before = previous.skills[name] || null, after = desired[name]?.hash || null;
    if (before === after) continue;
    const staged = path.join(root, ".staged-" + name), backup = path.join(root, ".backup-" + name);
    safe(staged); safe(backup);
    if (fs.existsSync(staged) || fs.existsSync(backup)) throw new Error("Native skills staging is occupied; existing files were preserved.");
    entries.push({ name, before, after, staged, backup });
  }
  write(journalFile, { format: 1, home: nativeHome, entries, beforeState: previous, afterState });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.after !== null) { fs.cpSync(desired[entry.name].directory, entry.staged, { recursive: true, errorOnExist: true, force: false }); if (digest(entry.staged) !== entry.after) throw new Error("Native skill source changed during copy; recovery was retained."); }
    if (digest(target) !== entry.before) throw new Error("Native skill changed during update; recovery was retained.");
    if (entry.before !== null) fs.renameSync(target, entry.backup);
    if (entry.after !== null) fs.renameSync(entry.staged, target);
  }
  write(stateFile, afterState);
  for (const entry of entries) if (fs.existsSync(entry.backup)) fs.rmSync(entry.backup, { recursive: true });
  fs.unlinkSync(journalFile);
  const legacyFile = path.join(privateRoot, "skills.json");
  if (fs.existsSync(legacyFile)) {
    const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    const removalFile = path.join(privateRoot, "legacy-plugin-removal.json"), removal = fs.existsSync(removalFile) ? JSON.parse(fs.readFileSync(removalFile, "utf8")) : null;
    const selected = source || previous.source;
    const legacySource = legacy.source || removal?.beforeState?.source;
    const sameScope = selected && legacySource && (marketplaceSkillsIdentity(selected).scope === marketplaceSkillsIdentity(legacySource).scope || !legacySource.organizationId && legacySource.cloneUrl === selected.cloneUrl && legacySource.marketplaceName === selected.marketplaceName);
    if ((sameScope && (Object.keys(legacy.plugins || {}).length || removal)) || (!selected && removal)) removeLegacyGrokPlugins({ home, privateRoot });
  }
}
`;
