export const GROK_CONFIG_TRANSACTION = `
function grokPrivateDirectory(directory) {
  const home = require("node:os").homedir(), root = path.join(home, ".archestra", "grok"), resolved = path.resolve(directory);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Grok private directory is outside the managed root.");
  const parents = [];
  for (let target = resolved; ; target = path.dirname(target)) {
    parents.unshift(target);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("Grok private directory has a linked or non-directory ancestor; no backup was written.");
    if (stat && process.platform !== "win32") {
      const privatePath = target === root || target.startsWith(root + path.sep);
      const userPath = privatePath || target === home || target === path.dirname(root);
      if (userPath && (stat.uid !== process.getuid() || (stat.mode & (privatePath ? 0o077 : 0o022)))) throw new Error("Grok private directory ownership or permissions are unsafe; no backup was written.");
    }
    if (path.dirname(target) === target) break;
  }
  for (const target of parents) if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
}
function grokFile(file) {
  for (let target = path.resolve(file); ; target = path.dirname(target)) {
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Grok will not replace symbolic links: " + target);
    if (path.dirname(target) === target) break;
  }
  if (!fs.existsSync(file)) return null;
  if (!fs.statSync(file).isFile()) throw new Error("Grok managed path is not a regular file: " + file);
  return fs.readFileSync(file);
}
function grokDigest(content) { return content === null ? null : require("node:crypto").createHash("sha256").update(content).digest("hex"); }
function validateGrokState(state, home) {
  if (state.home && state.home !== home || state.config !== path.join(home, "config.toml")) throw new Error("GROK_HOME differs from the managed snapshot; no other configuration was accessed.");
  if (state.activeConfig && state.activeConfig !== path.join(require("node:os").homedir(), ".archestra/grok/native/config.toml")) throw new Error("Managed Grok profile differs from its approved private path.");
  grokFile(state.config);
  if (state.activeConfig) grokFile(state.activeConfig);
}
function readGrokSnapshot(file) {
  try { const state = JSON.parse(grokFile(file).toString()); if (state && typeof state === "object" && !Array.isArray(state)) return state; } catch {}
  throw new Error("Grok connection snapshot is invalid. Preserve the private directory for local reconciliation; no configuration was replaced.");
}
function grokTransactionFiles(root, home) {
  return [path.join(home, "config.toml"), ...["native/config.toml", "native/managed_config.toml", "connection.json", "launch.cjs", "login.cjs", "sign-in.cjs", "disconnect.cjs", "skills.cjs", "startup.sh", "startup.ps1"].map(name => path.join(root, name)), ...(typeof grokShellProfiles === "function" ? grokShellProfiles() : [])];
}
function acquireGrokLock(root) {
  const file = path.join(root, "update.lock");
  grokFile(file);
  const create = () => { const descriptor = fs.openSync(file, "wx", 0o600); fs.writeFileSync(descriptor, JSON.stringify({pid:process.pid})); fs.closeSync(descriptor); };
  try { create(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let previous;
    try { previous = JSON.parse(grokFile(file).toString()); } catch { throw new Error("Grok update lock is unreadable; preserve it and reconcile locally."); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Grok update lock has an unknown owner.");
    try { process.kill(previous.pid, 0); throw new Error("Another Grok managed update is active. Wait for it to finish."); }
    catch (probe) { if (probe.code !== "ESRCH") throw probe; }
    fs.unlinkSync(file); create();
  }
  const release = () => { try { if (JSON.parse(grokFile(file)?.toString() || "{}").pid === process.pid) fs.unlinkSync(file); } catch {} };
  process.once("exit", release);
  return () => { process.removeListener("exit", release); release(); };
}
function recoverGrokTransaction(root, home) {
  const journalFile = path.join(root, "update.json"), content = grokFile(journalFile);
  if (content === null) return;
  let journal;
  try { journal = JSON.parse(content.toString()); } catch { throw new Error("Grok recovery journal is unreadable. Preserve the private directory; no configuration was replaced."); }
  const allowed = grokTransactionFiles(root, home);
  if (journal.format !== 1 || journal.home !== home || !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > allowed.length || new Set(journal.entries.map(entry => entry.file)).size !== journal.entries.length) throw new Error("Grok recovery journal identity is invalid.");
  for (const entry of journal.entries) {
    if (!allowed.includes(entry.file)) throw new Error("Grok recovery journal contains an unowned path.");
    for (const side of ["before", "after"]) {
      const encoded = entry[side], bytes = encoded === null ? null : typeof encoded === "string" ? Buffer.from(encoded, "base64") : undefined;
      if (bytes === undefined || grokDigest(bytes) !== entry[side + "Digest"]) throw new Error("Grok recovery journal digest is invalid.");
    }
    const digest = grokDigest(grokFile(entry.file));
    if (digest !== entry.beforeDigest && digest !== entry.afterDigest) throw new Error("Grok recovery found a concurrent change at " + path.basename(entry.file) + ". The private journal retains both known versions; no unknown value was overwritten. Reconcile this path locally.");
  }
  for (const entry of journal.entries) {
    const digest = grokDigest(grokFile(entry.file));
    if (digest === entry.afterDigest) continue;
    if (digest !== entry.beforeDigest) throw new Error("Grok recovery stopped for a concurrent change; private journal retained.");
    replaceGrokFile(entry.file, entry.after, entry.beforeDigest);
  }
  for (const entry of journal.entries) if (grokDigest(grokFile(entry.file)) !== entry.afterDigest) throw new Error("Grok recovery stopped for a concurrent change; private journal retained.");
  fs.unlinkSync(journalFile);
}
function replaceGrokFile(file, encoded, expectedDigest) {
  grokFile(file);
  if (grokDigest(grokFile(file)) !== expectedDigest) throw new Error("Concurrent Grok write detected; unknown content was preserved.");
  if (encoded === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
  else writeAtomic(file, Buffer.from(encoded, "base64"), expectedDigest);
}
function commitGrokTransaction(options) {
  const {root, home, changes} = options, allowed = grokTransactionFiles(root, home), journalFile = path.join(root, "update.json");
  if (grokFile(journalFile) !== null) throw new Error("Recover the pending Grok update before starting another.");
  const entries = changes.map(change => {
    if (!allowed.includes(change.file)) throw new Error("Unowned Grok transaction path.");
    const before = grokFile(change.file), after = change.content === null ? null : Buffer.from(change.content);
    if (Object.hasOwn(change, "expected") && grokDigest(before) !== grokDigest(change.expected === null ? null : Buffer.from(change.expected))) throw new Error("Grok configuration changed during setup. Nothing was replaced; close the native settings editor and reconnect.");
    return { file: change.file, before: before?.toString("base64") ?? null, after: after?.toString("base64") ?? null, beforeDigest: grokDigest(before), afterDigest: grokDigest(after) };
  });
  if (new Set(entries.map(entry => entry.file)).size !== entries.length) throw new Error("Duplicate Grok transaction path.");
  let stage = "update.json";
  try {
    writeAtomic(journalFile, JSON.stringify({format:1,home,entries}));
    for (const entry of entries) {
      stage = path.basename(entry.file);
      if (grokDigest(grokFile(entry.file)) !== entry.beforeDigest) throw new Error("Grok configuration changed during commit; unknown edits were preserved.");
      replaceGrokFile(entry.file, entry.after, entry.beforeDigest);
    }
    stage = "final generation verification";
    for (const entry of entries) if (grokDigest(grokFile(entry.file)) !== entry.afterDigest) throw new Error("Concurrent Grok write detected after commit; private recovery journal retained.");
    fs.unlinkSync(journalFile);
  } catch (error) {
    let restored = true;
    for (const entry of [...entries].reverse()) {
      try {
        const digest = grokDigest(grokFile(entry.file));
        if (digest === entry.beforeDigest) continue;
        if (digest !== entry.afterDigest) { restored = false; continue; }
        replaceGrokFile(entry.file, entry.before, entry.afterDigest);
      } catch { restored = false; }
    }
    if (restored && fs.existsSync(journalFile)) fs.unlinkSync(journalFile);
    const code = typeof error.code === "string" && /^E[A-Z0-9_]{1,24}$/.test(error.code) ? error.code : "IO";
    throw new Error("Grok update stopped at " + stage + " (" + code + "). " + (restored ? "The previous configuration, snapshot and helpers were restored. Close the local editor and rerun this updated installer." : "Not every file could be restored. Private update.json retains verified before/after backups. Close the native settings editor and rerun this updated installer for recovery; unknown changes are never overwritten."));
  }
}
`;
