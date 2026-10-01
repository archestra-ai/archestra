/** Shared configuration editor for the POSIX and PowerShell connection flows. */
export function renderClaudePermissionSettingsScript(
  operation: "connect" | "disconnect" | "verify-disconnect",
  owner?: string,
): string {
  return `const operation = ${JSON.stringify(operation)};
const owner = ${JSON.stringify(owner) ?? "undefined"};
${CLAUDE_PERMISSION_SETTINGS_SCRIPT}`;
}

const CLAUDE_PERMISSION_SETTINGS_SCRIPT = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readObject(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
    const value = raw.trim() ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {};
    if (!object(value)) throw new Error();
    return { value, bom: raw.startsWith("\uFEFF") };
  } catch {
    throw new Error("Cannot read " + label + "; existing settings were not changed.");
  }
}

function writeObject(file, value, bom = false) {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  if (fs.existsSync(file)) {
    if (!(mode & 0o222)) throw new Error("Claude configuration is read-only.");
    fs.accessSync(file, fs.constants.W_OK);
  }
  const tmp = file + ".archestra-" + process.pid + "-" + randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, (bom ? "\uFEFF" : "") + JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function snapshot(value, key) {
  return Object.hasOwn(value, key) ? { present: true, value: value[key] } : { present: false };
}

function validSnapshot(value) {
  return object(value) && typeof value.present === "boolean" &&
    (!value.present || Object.hasOwn(value, "value"));
}

function restore(value, key, installed, previous) {
  if (value[key] !== installed) return;
  if (previous.present) value[key] = previous.value;
  else delete value[key];
}

try {
  const directory = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const logicalSettings = path.join(directory, "settings.json");
  const stateFile = path.join(directory, ".archestra-permission-mode.json");
  const exists = fs.existsSync(logicalSettings);
  if (operation === "disconnect" && !fs.existsSync(stateFile)) process.exit(0);
  if (operation === "connect") fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const settingsFile = exists ? fs.realpathSync(logicalSettings) : logicalSettings;
  const { value: settings, bom } = exists
    ? readObject(settingsFile, "Claude settings")
    : { value: {}, bom: false };
  if (operation === "verify-disconnect") {
    if (fs.existsSync(stateFile)) throw new Error("Claude permission-mode restoration is incomplete.");
    if (owner && object(settings.env) &&
        [settings.env.ANTHROPIC_BASE_URL, settings.env.ANTHROPIC_BEDROCK_BASE_URL].includes(owner)) {
      throw new Error("Claude is still configured for this LLM proxy.");
    }
    process.exit(0);
  }
  if (Object.hasOwn(settings, "permissions") && !object(settings.permissions)) {
    throw new Error("Claude permissions must be an object; existing settings were not changed.");
  }
  const permissionsPresent = Object.hasOwn(settings, "permissions");
  const permissions = settings.permissions || {};
  let state;
  if (fs.existsSync(stateFile)) {
    if (fs.lstatSync(stateFile).isSymbolicLink()) throw new Error("The permission backup cannot be a symlink.");
    state = readObject(stateFile, "the Claude permission backup").value;
    if (state.version !== 1 || state.settingsFile !== settingsFile ||
        typeof state.permissionsPresent !== "boolean" ||
        !validSnapshot(state.defaultMode) || !validSnapshot(state.disableAutoMode)) {
      throw new Error("The Claude permission backup does not match this settings file; no changes applied.");
    }
    if (operation === "disconnect" && state.owner !== owner) {
      throw new Error("Claude permission settings belong to a different connection; no changes applied.");
    }
  }
  if (operation === "connect") {
    const backup = logicalSettings + ".archestra-backup";
    if (exists && !fs.existsSync(backup)) fs.copyFileSync(settingsFile, backup, fs.constants.COPYFILE_EXCL);
    if (!state) {
      state = {
        version: 1,
        settingsFile,
        permissionsPresent,
        defaultMode: snapshot(permissions, "defaultMode"),
        disableAutoMode: snapshot(settings, "disableAutoMode"),
      };
    } else {
      // A new approved connection may reapply the mode after user edits.
      // Preserve those edits as the new baseline instead of restoring stale values.
      if (permissions.defaultMode !== "acceptEdits") {
        state.defaultMode = snapshot(permissions, "defaultMode");
        state.permissionsPresent = permissionsPresent;
      }
      if (settings.disableAutoMode !== "disable") state.disableAutoMode = snapshot(settings, "disableAutoMode");
    }
    state.owner = owner;
    writeObject(stateFile, state);
    settings.permissions = permissions;
    permissions.defaultMode = "acceptEdits";
    settings.disableAutoMode = "disable";
    writeObject(settingsFile, settings, bom);
    console.log("Claude Code starts in acceptEdits mode; auto mode is disabled. Other commands still follow existing permissions.");
  } else {
    if (exists) {
      restore(permissions, "defaultMode", "acceptEdits", state.defaultMode);
      restore(settings, "disableAutoMode", "disable", state.disableAutoMode);
      if (!state.permissionsPresent && Object.keys(permissions).length === 0) delete settings.permissions;
      writeObject(settingsFile, settings, bom);
    }
    fs.unlinkSync(stateFile);
    console.log("Restored owned Claude permission-mode settings; later user edits were kept.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not update Claude permission-mode settings.");
  process.exitCode = 1;
}
`;
