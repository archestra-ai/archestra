/**
 * The cleanup helper setup writes beside Cursor's Guardrails hook. It removes
 * what the Cursor setup added on a computer, and nothing else: the hooks, the
 * gateway and the web tools in ~/.cursor/mcp.json, their entries on the MCP
 * allowlist, the shared skills, the changes to Cursor's settings, the
 * command-line agent's sign-ins to the gateway, and the helper folder with
 * its credential. The disconnect page has a chat run it, and a person runs it
 * in a terminal when Cursor cannot.
 *
 * Cursor's command-line agent stays installed and signed in to Cursor, also
 * when setup installed it for the web tools: it is an app of Cursor's that
 * works without this deployment, and the person may go on using it.
 *
 * Each part is found by what it points at, not by a record of what setup
 * wrote, so a part removed by hand, or added by an earlier setup under another
 * name, is handled the same way. Entries of the person's own stay.
 *
 * Cursor writes its settings back when it quits, so the helper changes them
 * only while Cursor is closed. Run from a chat it takes everything else out,
 * keeps itself, and leaves a copy of itself waiting in the background: when
 * Cursor next closes, the copy restores the settings and deletes the helper.
 * Nobody has to run anything else. The copy stops without a change when a new
 * setup has connected Cursor again, or when someone finished the cleanup in
 * a terminal first.
 *
 * Setup prepends a line that defines SETUP: the deployment's addresses, the
 * names it gave the two MCP servers, and the product name.
 */
import {
  CURSOR_GUARDRAILS_HOOK_CONFIG_FILENAME,
  CURSOR_GUARDRAILS_HOOK_FILENAME,
} from "./cursor-guardrails-hook";
import {
  CURSOR_WEB_CLI_DATA_DIRNAME,
  CURSOR_WEB_TOOLS_FILENAME,
} from "./cursor-web-tools";

export const CURSOR_DISCONNECT_FILENAME = "disconnect.cjs";

/** Cursor's settings-store row behind Settings > Models > API Keys and its tool switches. */
export const CURSOR_APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

/** Row recording the Model Router ids the last setup added to Cursor's picker. */
export const CURSOR_ROUTER_MODELS_KEY = "archestra/cursorModelRouterModels";

/** Row recording Cursor's web tool settings as they were before setup switched them off. */
export const CURSOR_WEB_TOOLS_KEY = "archestra/cursorWebTools";

/** What setup knows that the helper cannot find on the computer. */
interface CursorDisconnectSetup {
  appName: string;
  /** Addresses of this deployment: an entry that points at one is its own. */
  origins: string[];
  /** The names setup gave the gateway and the web tools in Cursor. */
  servers: string[];
  /** How this deployment's keys start, to tell its key from the person's own. */
  tokenPrefixes: string[];
}

/** The helper as setup writes it. */
export function cursorDisconnectHelper(setup: CursorDisconnectSetup): string {
  return `const SETUP = ${JSON.stringify(setup)};\n${CURSOR_DISCONNECT}`;
}

const CURSOR_DISCONNECT = `// Cleanup helper for Cursor. Setup writes this file; it removes what setup
// added to Cursor on this computer and nothing else.
//   node disconnect.cjs [--wait] [--keep-skills]
// --wait gives a person two minutes to quit Cursor, whose settings can only
// be changed while it is closed. Without it, or after those two minutes, the
// helper goes on waiting in the background and finishes when Cursor closes.
// Run it again at any time: a part that is already gone is skipped.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const windows = process.platform === "win32";
const flags = new Set(process.argv.slice(2));
const cursorDir = path.join(os.homedir(), ".cursor");
const ownDir = path.join(cursorDir, "archestra");
const self = path.join(ownDir, ${JSON.stringify(CURSOR_DISCONNECT_FILENAME)});
// The background copy touches this file while it waits for Cursor to close.
const waiterFile = path.join(ownDir, "finishing");
const pollMs = Number(process.env.ARCHESTRA_CURSOR_DISCONNECT_POLL_MS) || 2000;
const hookConfig = path.join(ownDir, ${JSON.stringify(CURSOR_GUARDRAILS_HOOK_CONFIG_FILENAME)});
const finishing = flags.has("--finish");
// The background copy gives up a day after it started.
const finishBy = Date.now() + 24 * 60 * 60 * 1000;
const appName = SETUP.appName || "the gateway";
const APPLICATION_USER_KEY = ${JSON.stringify(CURSOR_APPLICATION_USER_KEY)};
const WEB_TOOLS_KEY = ${JSON.stringify(CURSOR_WEB_TOOLS_KEY)};
const ROUTER_MODELS_KEY = ${JSON.stringify(CURSOR_ROUTER_MODELS_KEY)};
const OPENAI_KEY_ROW = "cursorAuth/openAIKey";

const done = [];
const left = [];
const failed = [];
let pending = false;
let pendingNote = "";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const slashes = (value) => String(value).replace(/\\\\/g, "/");
const originOf = (value) => {
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
};
const origins = new Set((SETUP.origins || []).map(originOf).filter(Boolean));
const pointsHere = (value) => origins.has(originOf(value));

function readJson(file) {
  if (!fs.existsSync(file)) return { exists: false };
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\\uFEFF/, "").trim();
    const value = raw ? JSON.parse(raw) : {};
    return { exists: true, value: isObject(value) ? value : null };
  } catch {
    return { exists: true, value: null };
  }
}

/**
 * Takes this connection's entries out of one of Cursor's JSON files. clean()
 * removes them from a parsed file and says how many there were and whether
 * anything else is left. The copy setup kept of the file is dropped once the
 * file is back to it. A file with nothing left is deleted when setup made it,
 * or when the kept copy only ever held an earlier setup's entries.
 * Returns what clean() found in the file, or null when nothing changed.
 */
function edit(file, clean, byHand) {
  const config = readJson(file);
  if (!config.exists) return null;
  if (!config.value) {
    failed.push(file + " has comments or is not valid JSON. " + byHand);
    return null;
  }
  const found = clean(config.value);
  if (found.count === 0) return null;
  const backup = file + ".archestra-backup";
  const original = readJson(backup);
  const stale = original.exists && original.value ? clean(original.value).count > 0 : false;
  const restored = Boolean(original.exists && original.value && JSON.stringify(original.value) === JSON.stringify(config.value));
  if (found.bare && (!original.exists || (restored && stale))) {
    fs.rmSync(file, { force: true });
  } else {
    const next = file + ".archestra-next";
    fs.writeFileSync(next, JSON.stringify(config.value, null, 2) + "\\n");
    fs.renameSync(next, file);
  }
  if (restored) fs.rmSync(backup, { force: true });
  return found;
}

const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

function cleanHooks() {
  const file = path.join(cursorDir, "hooks.json");
  const found = edit(
    file,
    (config) => {
      const hooks = isObject(config.hooks) ? config.hooks : {};
      let count = 0;
      for (const step of Object.keys(hooks)) {
        if (!Array.isArray(hooks[step])) continue;
        const rest = hooks[step].filter((entry) => !(typeof entry?.command === "string" && slashes(entry.command).includes(${JSON.stringify(`/.cursor/archestra/${CURSOR_GUARDRAILS_HOOK_FILENAME}`)})));
        if (rest.length === hooks[step].length) continue;
        count += hooks[step].length - rest.length;
        if (rest.length > 0) hooks[step] = rest;
        else delete hooks[step];
      }
      return { count, bare: Object.keys(hooks).length === 0 && onlyKeys(config, ["version", "hooks"]) };
    },
    "Remove the entries that run .cursor/archestra/guardrails-hook.mjs by hand.",
  );
  if (found) done.push("Removed the " + appName + " Guardrails hooks from " + file + ".");
}

/** Removes the gateway and the web tools; returns the names they had. */
function cleanMcp() {
  const file = path.join(cursorDir, "mcp.json");
  const found = edit(
    file,
    (config) => {
      const servers = isObject(config.mcpServers) ? config.mcpServers : {};
      const names = Object.keys(servers).filter((name) => {
        const entry = servers[name];
        if (!isObject(entry)) return false;
        const gateway = typeof entry.url === "string" && pointsHere(entry.url) && entry.url.includes("/mcp/");
        const web = Array.isArray(entry.args) && entry.args.some((arg) => typeof arg === "string" && slashes(arg).endsWith(${JSON.stringify(`/.cursor/archestra/${CURSOR_WEB_TOOLS_FILENAME}`)}));
        return gateway || web;
      });
      for (const name of names) delete servers[name];
      return { count: names.length, names, bare: Object.keys(servers).length === 0 && onlyKeys(config, ["mcpServers"]) };
    },
    "Remove the servers that point at " + [...origins].join(" or ") + " and the one that runs .cursor/archestra/web-tools.mjs by hand.",
  );
  if (!found) return [];
  done.push("Removed " + found.names.map((name) => '"' + name + '"').join(" and ") + " from the MCP servers in " + file + ".");
  return found.names;
}

function cleanAllowlist(names) {
  const file = path.join(cursorDir, "permissions.json");
  const ours = new Set([...names, ...(SETUP.servers || [])].map((name) => String(name).toLowerCase()));
  const found = edit(
    file,
    (config) => {
      const list = Array.isArray(config.mcpAllowlist) ? config.mcpAllowlist : [];
      const rest = list.filter((entry) => !(typeof entry === "string" && entry.includes(":") && ours.has(entry.slice(0, entry.indexOf(":")).toLowerCase())));
      if (rest.length < list.length) {
        if (rest.length > 0) config.mcpAllowlist = rest;
        else delete config.mcpAllowlist;
      }
      return { count: list.length - rest.length, bare: Object.keys(config).length === 0 };
    },
    "Remove the " + appName + " tools from its mcpAllowlist by hand.",
  );
  if (found) done.push("Removed " + found.count + " " + appName + " tools from the MCP allowlist in " + file + ".");
}

function cleanSkills() {
  const root = path.join(cursorDir, "skills");
  if (!fs.existsSync(root)) return;
  let removed = false;
  for (const name of fs.readdirSync(root)) {
    const folder = path.join(root, name);
    let config = "";
    try {
      config = fs.readFileSync(path.join(folder, ".git", "config"), "utf8");
    } catch {
      continue;
    }
    const cloned = [...config.matchAll(/^\\s*url\\s*=\\s*(\\S+)/gm)].some((match) => pointsHere(match[1]) && match[1].includes("/skills/"));
    if (!cloned) continue;
    if (flags.has("--keep-skills")) {
      left.push("Kept the shared skills in " + folder + ".");
      continue;
    }
    try {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
      done.push("Deleted the shared skills in " + folder + ".");
      removed = true;
    } catch {
      failed.push("Could not delete " + folder + ". Delete it by hand.");
    }
  }
  // The folder the clone sat in goes too once nothing else is in it. Cursor
  // makes it again when a skill is added.
  try {
    if (removed && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch {}
}

const stateDb = () =>
  (windows
    ? [path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "state.vscdb")]
    : [
        path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
        path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor", "User", "globalStorage", "state.vscdb"),
      ]
  ).find((candidate) => fs.existsSync(candidate)) || null;

/**
 * The process ids of a running Cursor. windowsHide matters: the waiting copy
 * has no console, and Windows would open a terminal window for each program
 * it starts.
 */
const cursorPids = () => {
  const found = (command, args) => {
    try {
      return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return "";
    }
  };
  const listed = windows
    ? [...found("tasklist", ["/FI", "IMAGENAME eq Cursor.exe", "/FO", "CSV", "/NH"]).matchAll(/^"cursor\\.exe","(\\d+)"/gim)].map((match) => match[1])
    : (found("pgrep", ["-x", "Cursor"]) + "\\n" + found("pgrep", ["-x", "cursor"])).split(/\\s+/);
  return listed.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
};
const cursorIsRunning = () => cursorPids().length > 0;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/**
 * Leaves a copy of this helper waiting for Cursor to close. Returns whether
 * one waits now. One is enough: a run while a copy still touches its file
 * starts none.
 */
function finishWhenClosed() {
  try {
    if (Date.now() - fs.statSync(waiterFile).mtimeMs < Math.max(10000, pollMs * 5)) return true;
  } catch {}
  try {
    const child = spawn(process.execPath, [self, "--finish"], { detached: true, stdio: "ignore", windowsHide: true });
    if (!child.pid) return false;
    child.on("error", () => {});
    child.unref();
    fs.writeFileSync(waiterFile, String(child.pid));
    return true;
  } catch {
    return false;
  }
}

/**
 * The background copy: waits for Cursor to close. Returns whether the
 * settings are still this helper's to restore. They are not once a new setup
 * has connected Cursor again, once the cleanup was finished in a terminal,
 * or after a day.
 */
function waitForCursorToClose() {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const until = finishBy;
  // Watches the processes it found once, which starts no program. It looks
  // for Cursor again only when all of them have gone.
  let pids = cursorPids();
  while (Date.now() < until) {
    if (!fs.existsSync(self) || fs.existsSync(hookConfig)) return false;
    if (!pids.some(alive)) {
      pids = cursorPids();
      if (pids.length === 0) return true;
    }
    try {
      fs.writeFileSync(waiterFile, String(process.pid));
    } catch {}
    Atomics.wait(pause, 0, 0, pollMs);
  }
  return false;
}

const SETTINGS_BY_HAND = "In Cursor Settings, switch Web Search Tool and Web Fetch Tool back on if you want them, and under Models > API Keys switch off the OpenAI API key if its base URL points at " + appName + ".";

/**
 * Cursor's settings: its two web tools go back to how they were before setup
 * switched them off, and model routing through this deployment comes off.
 * Cursor writes its settings back when it quits, so they change only while
 * it is closed.
 */
function cleanSettings() {
  // The waiting copy and a person's run can reach the settings at the same
  // moment, and the second to write finds them locked. It tries again, and
  // then finds the change made.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    const before = [done.length, left.length, failed.length];
    settingsFailed = false;
    restoreSettings();
    if (!settingsFailed || attempt === 5) return;
    done.length = before[0];
    left.length = before[1];
    failed.length = before[2];
    Atomics.wait(pause, 0, 0, 400);
  }
}

let settingsFailed = false;

/** One try at the settings. Sets settingsFailed when they could not be read or written. */
function restoreSettings() {
  const file = stateDb();
  if (!file) return;
  let sqlite;
  try {
    process.emitWarning = () => {};
    sqlite = require("node:sqlite");
  } catch {
    return left.push("This Node.js cannot open Cursor's settings. " + SETTINGS_BY_HAND);
  }
  const text = (row) => (row ? (ArrayBuffer.isView(row.value) ? Buffer.from(row.value).toString("utf8") : String(row.value)) : "");
  const parsed = (value) => {
    try {
      return JSON.parse(value || "null");
    } catch {
      return null;
    }
  };
  const plan = (store) => {
    const read = store.prepare("SELECT value FROM ItemTable WHERE key = ?");
    const user = parsed(text(read.get(APPLICATION_USER_KEY)));
    const web = parsed(text(read.get(WEB_TOOLS_KEY)));
    const models = parsed(text(read.get(ROUTER_MODELS_KEY)));
    // The key setting is this deployment's when its base URL points here.
    // The URL alone counts: a later setup that kept Cursor's own models
    // switched the key off and left the URL in place. The record of the
    // models a setup listed says only which models to take out of the
    // picker: the person may have pointed the setting at another service
    // since, and that setting is theirs.
    const owned = isObject(user) && pointsHere(user.openAIBaseUrl);
    const listed = Array.isArray(models);
    return { user, web: isObject(web) ? web : null, models: listed ? models : [], owned, listed };
  };
  try {
    const peek = new sqlite.DatabaseSync(file, { readOnly: true });
    let todo;
    try {
      todo = plan(peek);
    } finally {
      peek.close();
    }
    if (!todo.web && !todo.owned && !todo.listed) return;
    if (cursorIsRunning() && flags.has("--wait")) {
      console.log("Quit Cursor to finish: Cursor keeps a settings change only when it is made while Cursor is closed. Waiting up to two minutes...");
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (let waited = 0; waited < 120 && cursorIsRunning(); waited++) Atomics.wait(pause, 0, 0, 1000);
    }
    if (cursorIsRunning()) {
      pending = true;
      pendingNote =
        "Cursor is running, so its settings are as setup left them for now" +
        (todo.web ? ": Web Search Tool and Web Fetch Tool are still switched off" : "") +
        (todo.owned ? (todo.web ? ", and" : ":") + " the OpenAI base URL under Models > API Keys still points at " + appName : "") +
        (!todo.owned && todo.listed ? (todo.web ? ", and " : ": ") + appName + "'s models are still in the model picker" : "") +
        ". ";
      return;
    }
    const store = new sqlite.DatabaseSync(file);
    try {
      const { user, web, models, owned, listed } = plan(store);
      const write = store.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
      const drop = store.prepare("DELETE FROM ItemTable WHERE key = ?");
      if (isObject(user) && web) {
        const state = isObject(user.composerState) ? user.composerState : (user.composerState = {});
        for (const [key, value] of Object.entries(web)) {
          if (value === null) delete state[key];
          else state[key] = value;
        }
        done.push("Switched Cursor's Web Search and Web Fetch tools back to how they were before setup.");
      }
      if (isObject(user) && (owned || listed)) {
        const ours = new Set(models);
        const settings = isObject(user.aiSettings) ? user.aiSettings : (user.aiSettings = {});
        const builtIn = (Array.isArray(user.availableDefaultModels2) ? user.availableDefaultModels2 : []).map((model) => model && model.name).filter(Boolean);
        for (const name of ["userAddedModels", "modelOverrideEnabled"]) settings[name] = (Array.isArray(settings[name]) ? settings[name] : []).filter((model) => !ours.has(model));
        let disabled = Array.isArray(settings.modelOverrideDisabled) ? settings.modelOverrideDisabled : [];
        // Every built-in model off is what setup left, not a person's choice.
        if (owned && builtIn.length > 0 && builtIn.every((model) => disabled.includes(model))) disabled = disabled.filter((model) => !builtIn.includes(model));
        settings.modelOverrideDisabled = disabled.filter((model) => !ours.has(model));
        const fallback = builtIn.includes("default") || builtIn.length === 0 ? "default" : builtIn[0];
        for (const feature of Object.values(isObject(settings.modelConfig) ? settings.modelConfig : {})) {
          if (isObject(feature) && ours.has(feature.modelName)) {
            feature.modelName = fallback;
            feature.selectedModels = [{ modelId: fallback, parameters: [] }];
          }
        }
        if (owned) {
          user.useOpenAIKey = false;
          // Cursor keeps the field with no value while no URL is set.
          user.openAIBaseUrl = null;
          const key = text(read(store, OPENAI_KEY_ROW));
          if ((SETUP.tokenPrefixes || []).some((prefix) => key.startsWith(prefix))) drop.run(OPENAI_KEY_ROW);
          done.push("Cursor uses its own models again: the OpenAI API key setting that pointed at " + appName + " is off, and its base URL and key are removed.");
        } else {
          done.push("Took " + appName + "'s models out of Cursor's model picker. The OpenAI API key setting points at another service now, so it stays as it is.");
        }
      }
      if (isObject(user)) write.run(APPLICATION_USER_KEY, JSON.stringify(user));
      drop.run(WEB_TOOLS_KEY);
      drop.run(ROUTER_MODELS_KEY);
    } finally {
      store.close();
    }
  } catch {
    settingsFailed = true;
    failed.push("Cursor's settings could not be changed. Run this again: node " + JSON.stringify(self) + " --wait. " + SETTINGS_BY_HAND);
  }
}

const read = (store, key) => store.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);

/**
 * Cursor's command-line agent keeps an MCP sign-in, and its approval of a
 * server, per folder. Setup signs it in to the gateway in the folder it ran
 * in, and the person may have done so in others: all of them go. The files
 * name servers only, so a server of the same name in a project's own config
 * is signed out too, and the agent asks for that sign-in again. The agent
 * itself and its sign-in to Cursor are not touched.
 */
function cleanCliSignIns() {
  const root = path.join(cursorDir, "projects");
  if (!fs.existsSync(root)) return;
  const ours = [...new Set(SETUP.servers || [])];
  const approved = (entry) => typeof entry === "string" && ours.some((name) => entry.startsWith(name + "-") && /^[0-9a-f]{16}$/.test(entry.slice(name.length + 1)));
  const rewrite = (file, value, empty) => {
    if (empty) return fs.rmSync(file, { force: true });
    const next = file + ".archestra-next";
    fs.writeFileSync(next, JSON.stringify(value, null, 2) + "\\n");
    fs.renameSync(next, file);
  };
  let folders = 0;
  for (const name of fs.readdirSync(root)) {
    try {
      const authFile = path.join(root, name, "mcp-auth.json");
      const auth = readJson(authFile);
      const mine = auth.exists && auth.value ? Object.keys(auth.value).filter((key) => ours.includes(key)) : [];
      if (mine.length > 0) {
        for (const key of mine) delete auth.value[key];
        rewrite(authFile, auth.value, Object.keys(auth.value).length === 0);
        folders += 1;
      }
      const approvalsFile = path.join(root, name, "mcp-approvals.json");
      if (!fs.existsSync(approvalsFile)) continue;
      const approvals = JSON.parse(fs.readFileSync(approvalsFile, "utf8").replace(/^\\uFEFF/, ""));
      if (!Array.isArray(approvals) || !approvals.some(approved)) continue;
      const rest = approvals.filter((entry) => !approved(entry));
      rewrite(approvalsFile, rest, rest.length === 0);
    } catch {
      failed.push("Could not remove the command-line agent's sign-in to " + appName + " tools in " + path.join(root, name) + ".");
    }
  }
  if (folders > 0)
    done.push("Removed the sign-in of Cursor's command-line agent to " + appName + " tools in " + folders + (folders === 1 ? " folder." : " folders."));
}

function cleanOwnFiles() {
  fs.rmSync(path.join(os.tmpdir(), ${JSON.stringify(CURSOR_WEB_CLI_DATA_DIRNAME)}), { recursive: true, force: true, maxRetries: 3 });
  if (!fs.existsSync(ownDir)) return;
  try {
    // This helper stays while Cursor's settings still wait for it, or could
    // not be changed: a later run finishes them.
    const unfinished = pending || settingsFailed;
    const keep = unfinished ? new Set([${JSON.stringify(CURSOR_DISCONNECT_FILENAME)}, path.basename(waiterFile)]) : new Set();
    const entries = fs.readdirSync(ownDir).filter((name) => !keep.has(name));
    for (const name of entries) fs.rmSync(path.join(ownDir, name), { recursive: true, force: true, maxRetries: 3 });
    if (!unfinished) fs.rmSync(ownDir, { recursive: true, force: true, maxRetries: 3 });
    if (entries.length > 0) done.push("Deleted the Guardrails helper, its credential and the web tools in " + ownDir + (unfinished ? ", except this helper." : "."));
  } catch {
    failed.push("Could not delete " + ownDir + ". Delete it by hand: it holds a credential.");
  }
}

if (finishing) {
  // Everything else went when the person asked; only the settings waited.
  // The copy goes on until they are restored: Cursor may open again before
  // it writes, and the settings store can be locked for a while.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let wait = pollMs; ; wait = Math.min(wait * 2, 60000)) {
    if (!waitForCursorToClose()) process.exit(0);
    pending = false;
    failed.length = 0;
    cleanSettings();
    if (!pending && !settingsFailed) break;
    if (settingsFailed) Atomics.wait(pause, 0, 0, wait);
  }
  cleanOwnFiles();
  process.exit(failed.length > 0 ? 1 : 0);
}
cleanHooks();
cleanAllowlist(cleanMcp());
cleanSkills();
cleanCliSignIns();
cleanSettings();
cleanOwnFiles();
// After the hook's credential is gone: the copy takes one as a new setup's.
if (pending)
  left.push(
    pendingNote +
      (finishWhenClosed()
        ? "They go back to how they were the next time you quit Cursor. There is nothing else to run."
        : "Quit Cursor, then run this to finish: node " + JSON.stringify(self) + " --wait"),
  );
// Settings that could not be changed now are tried again in the background.
else if (settingsFailed) finishWhenClosed();

for (const line of done) console.log(line);
for (const line of left) console.log(line);
for (const line of failed) console.log("Could not disconnect: " + line);
if (done.length === 0 && left.length === 0 && failed.length === 0) console.log("Nothing of the " + appName + " connection is left in Cursor on this computer.");
else if (failed.length === 0 && !pending) console.log("Cursor is disconnected from " + appName + " on this computer. Reload Cursor to load the change.");
process.exit(failed.length > 0 ? 1 : 0);
`;
