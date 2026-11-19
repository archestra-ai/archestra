import {
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared/archestra-mcp-server";
import { ALL_ARCHESTRA_TOKEN_PREFIXES } from "@archestra/shared/consts";
import {
  CURSOR_APPLICATION_USER_KEY,
  CURSOR_DISCONNECT_FILENAME,
  CURSOR_ROUTER_MODELS_KEY,
  CURSOR_WEB_TOOLS_KEY,
  cursorDisconnectHelper,
} from "../payloads/cursor-disconnect";
import {
  CURSOR_GUARDRAILS_ENFORCING_STEPS,
  CURSOR_GUARDRAILS_HOOK,
  CURSOR_GUARDRAILS_HOOK_CONFIG_FILENAME,
  CURSOR_GUARDRAILS_HOOK_FILENAME,
  CURSOR_GUARDRAILS_HOOK_STEPS,
  CURSOR_GUARDRAILS_HOOK_TIMEOUT_SECONDS,
} from "../payloads/cursor-guardrails-hook";
import {
  CURSOR_WEB_CLI_DIRNAME,
  CURSOR_WEB_CLI_PERMISSIONS,
  CURSOR_WEB_FETCH_TOOL,
  CURSOR_WEB_SEARCH_TOOL,
  CURSOR_WEB_SETUP_TOOL,
  CURSOR_WEB_SIGN_IN_FILENAME,
  CURSOR_WEB_TOOLS,
  CURSOR_WEB_TOOLS_FILENAME,
  cursorWebSignInHelper,
} from "../payloads/cursor-web-tools";
import { mergeJsonFileBash } from "../steps/json-merge";
import { describeMarketplaceContents } from "../steps/marketplace-copy";
import { legacyServerNames } from "../steps/mcp";
import { nodeScriptRenderers } from "../steps/node-script";
import { psq, sh } from "../steps/quoting";
import type {
  AgentEnding,
  SetupScriptContext,
  SetupScriptProxySection,
  ShellAgentSetup,
} from "../types";

// Cursor setup. Cursor has no CLI to drive: the script merges ~/.cursor/mcp.json,
// clones the skills, and writes the model settings into Cursor's settings
// database. Bash and PowerShell versions sit side by side, then the agent module
// the dispatcher in ../index.ts uses.

const CURSOR_MCP_MERGE_PY = `import json, os, pathlib
path = pathlib.Path(os.path.expanduser("~/.cursor/mcp.json"))
config = {}
if path.exists():
    raw = path.read_text().strip()
    if raw:
        config = json.loads(raw)
servers = config.setdefault("mcpServers", {})
# Move, not add: an entry left by an earlier connect run points at this same
# gateway, so it is dropped rather than left beside the new one.
for legacy in json.loads(os.environ.get("ARCHESTRA_MCP_LEGACY_NAMES", "[]")):
    servers.pop(legacy, None)
servers[os.environ["ARCHESTRA_MCP_SERVER_NAME"]] = {
    "url": os.environ["ARCHESTRA_MCP_SERVER_URL"],
}
path.write_text(json.dumps(config, indent=2) + "\\n")
print(f"Updated {path}")`;

// Cursor keeps its API key settings in a SQLite store rather than a JSON file.
// The Settings > Models > API Keys toggles live in the applicationUser blob and
// the key in its own row. Values arrive through the child process env.
//
// The picker then lists only the Model Router's models: they become user-added
// models, and every built-in model Cursor knows of is switched off (a user can
// switch one back on). Cursor's "Use OpenAI API Key" setting covers every
// model, and its own models refuse a custom key ("This model does not support
// custom API keys"), so with the key on they cannot answer anyway. The ids
// written are remembered in their own row, so a re-run replaces them instead
// of keeping models the router no longer lists.
const CURSOR_MODEL_SETTINGS_PY = `import json, os, sqlite3

def set_picker_models(db, user, models):
    ids = models["ids"]
    marker = "${CURSOR_ROUTER_MODELS_KEY}"
    row = db.execute("SELECT value FROM ItemTable WHERE key = ?", (marker,)).fetchone()
    stale = set(json.loads(row[0])) if row and row[0] else set()
    built_in = [m["name"] for m in user.get("availableDefaultModels2", []) if m.get("name")]
    ours = set(ids) | stale
    settings = user.setdefault("aiSettings", {})
    settings["userAddedModels"] = [
        m for m in settings.get("userAddedModels", []) if m not in ours
    ] + ids
    settings["modelOverrideEnabled"] = [
        m for m in settings.get("modelOverrideEnabled", [])
        if m not in ours and m not in built_in
    ] + ids
    settings["modelOverrideDisabled"] = [
        m for m in settings.get("modelOverrideDisabled", [])
        if m not in ours and m not in built_in
    ] + built_in
    # Chat, Cmd+K and the other features keep their own selected model; move
    # any still on a built-in model to the organization's default.
    default = models.get("defaultId")
    if default:
        for feature in settings.get("modelConfig", {}).values():
            if isinstance(feature, dict) and feature.get("modelName") not in ids:
                feature["modelName"] = default
                feature["selectedModels"] = [{"modelId": default, "parameters": []}]
    db.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        (marker, json.dumps(ids)),
    )

path = os.environ["ARCHESTRA_CURSOR_STATE_DB"]
backup = path + ".archestra-backup"
db = sqlite3.connect(path, timeout=5)
try:
    # Back up once, so a re-run keeps the pre-Archestra copy.
    if not os.path.exists(backup):
        copy = sqlite3.connect(backup)
        db.backup(copy)
        copy.close()
    row = db.execute(
        "SELECT key, value FROM ItemTable WHERE key LIKE ?",
        ("%persistentStorage.applicationUser",),
    ).fetchone()
    key = row[0] if row else "${CURSOR_APPLICATION_USER_KEY}"
    user = json.loads(row[1]) if row and row[1] else {}
    user["openAIBaseUrl"] = os.environ["ARCHESTRA_CURSOR_BASE_URL"]
    user["useOpenAIKey"] = True
    models = json.loads(os.environ.get("ARCHESTRA_CURSOR_MODELS") or "null")
    if models and models["ids"]:
        set_picker_models(db, user, models)
    db.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        (key, json.dumps(user)),
    )
    db.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ("cursorAuth/openAIKey", os.environ["ARCHESTRA_CURSOR_API_KEY"]),
    )
    db.commit()
finally:
    db.close()`;

// A setup that keeps Cursor on its own models undoes what an earlier setup
// did to route them: the API key setting goes off, the Model Router's
// models leave the picker, and built-in models come back to Cursor's defaults
// when all of them were switched off. Nothing changes for a person who never
// routed Cursor's models through this deployment. A person who has since
// pointed the key setting at another service keeps that setting: only the
// models the earlier setup listed leave the picker. The setting is this
// deployment's when its base URL is one of the deployment's addresses.
const cursorPlanModelsPy = (
  origins: readonly string[],
) => `import json, os, sqlite3
from urllib.parse import urlsplit

path = os.environ["ARCHESTRA_CURSOR_STATE_DB"]
marker = "${CURSOR_ROUTER_MODELS_KEY}"
origins = set(json.loads(${JSON.stringify(JSON.stringify(origins))}))


def origin(url):
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if not parts.scheme or not parts.hostname:
        return None
    default = {"http": 80, "https": 443}.get(parts.scheme)
    host = parts.hostname if ":" not in parts.hostname else "[" + parts.hostname + "]"
    return parts.scheme + "://" + host + ("" if port in (None, default) else ":" + str(port))


db = sqlite3.connect(path, timeout=5)
try:
    row = db.execute(
        "SELECT key, value FROM ItemTable WHERE key LIKE ?",
        ("%persistentStorage.applicationUser",),
    ).fetchone()
    stale = db.execute("SELECT value FROM ItemTable WHERE key = ?", (marker,)).fetchone()
    user = json.loads(row[1]) if row and row[1] else None
    ours = set(json.loads(stale[0])) if stale and stale[0] else set()
    owned = origin((user or {}).get("openAIBaseUrl") or "") in origins
    # The key switched off is what this script leaves, so a second run is quiet.
    if user is not None and (ours or (owned and user.get("useOpenAIKey"))):
        settings = user.setdefault("aiSettings", {})
        built_in = [m["name"] for m in user.get("availableDefaultModels2", []) if m.get("name")]
        for name in ("userAddedModels", "modelOverrideEnabled"):
            settings[name] = [m for m in settings.get(name, []) if m not in ours]
        disabled = settings.get("modelOverrideDisabled", [])
        if owned:
            user["useOpenAIKey"] = False
            # Every built-in model off is what the earlier setup left, not a
            # person's choice.
            if built_in and all(m in disabled for m in built_in):
                disabled = [m for m in disabled if m not in built_in]
        settings["modelOverrideDisabled"] = [m for m in disabled if m not in ours]
        fallback = "default" if "default" in built_in or not built_in else built_in[0]
        for feature in settings.get("modelConfig", {}).values():
            if isinstance(feature, dict) and feature.get("modelName") in ours:
                feature["modelName"] = fallback
                feature["selectedModels"] = [{"modelId": fallback, "parameters": []}]
        db.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
            (row[0], json.dumps(user)),
        )
        db.execute("DELETE FROM ItemTable WHERE key = ?", (marker,))
        db.commit()
        if owned:
            print("restored")
finally:
    db.close()`;

// Cursor runs hooks for every chat, on Cursor's own models as on Archestra's,
// so they carry Guardrails where the LLM proxy never sees the model. The hook
// helper and its credential go in ~/.cursor/archestra; hooks.json keeps any
// hooks of the user's own, and a re-run replaces only the entries that run
// this helper. On macOS and Linux the command names this Node.js by absolute
// path, since Cursor started from the Dock may not have the shell's PATH. On
// Windows it starts with a bare `node`, which both cmd and PowerShell run; a
// quoted path first is only a string to PowerShell.
function renderCursorGuardrailsHookSetup(ctx: SetupScriptContext): string {
  const hook = ctx.cursorGuardrailsHook;
  if (!hook) return "";
  return `const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = path.join(os.homedir(), ".cursor", "archestra");
const helper = path.join(dir, ${JSON.stringify(CURSOR_GUARDRAILS_HOOK_FILENAME)});
const hooksPath = path.join(os.homedir(), ".cursor", "hooks.json");
let config = { version: 1, hooks: {} };
if (fs.existsSync(hooksPath)) {
  const raw = fs.readFileSync(hooksPath, "utf8").replace(/^\\uFEFF/, "").trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch {
      console.error("error: " + hooksPath + " is not valid JSON. Fix or move it, then run setup again.");
      process.exit(1);
    }
  }
  if (!fs.existsSync(hooksPath + ".archestra-backup")) fs.copyFileSync(hooksPath, hooksPath + ".archestra-backup");
}
if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
if (typeof config.version !== "number") config.version = 1;
if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) config.hooks = {};
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(helper, ${JSON.stringify(CURSOR_GUARDRAILS_HOOK)});
fs.writeFileSync(path.join(dir, ${JSON.stringify(CURSOR_DISCONNECT_FILENAME)}), ${JSON.stringify(renderCursorDisconnectHelper(ctx))});
const settings = path.join(dir, ${JSON.stringify(CURSOR_GUARDRAILS_HOOK_CONFIG_FILENAME)});
fs.writeFileSync(settings, JSON.stringify(${JSON.stringify({ url: hook.url, token: hook.token, appName: ctx.appName })}) + "\\n", { mode: 0o600 });
fs.chmodSync(settings, 0o600);
const runHelper =
  process.platform === "win32"
    ? 'node "' + helper + '"'
    : [process.execPath, helper].map((value) => "'" + value.replace(/'/g, "'\\\\''") + "'").join(" ");
const ours = (entry) =>
  typeof entry?.command === "string" &&
  entry.command.replace(/\\\\/g, "/").includes("/.cursor/archestra/" + ${JSON.stringify(CURSOR_GUARDRAILS_HOOK_FILENAME)});
const enforcing = ${JSON.stringify(CURSOR_GUARDRAILS_ENFORCING_STEPS)};
for (const step of ${JSON.stringify(CURSOR_GUARDRAILS_HOOK_STEPS)}) {
  const kept = Array.isArray(config.hooks[step]) ? config.hooks[step].filter((entry) => !ours(entry)) : [];
  config.hooks[step] = [
    ...kept,
    {
      command: runHelper + " " + step,
      timeout: ${CURSOR_GUARDRAILS_HOOK_TIMEOUT_SECONDS},
      ...(enforcing.includes(step) ? { failClosed: true } : {}),
    },
  ];
}
const next = hooksPath + ".archestra-next";
fs.writeFileSync(next, JSON.stringify(config, null, 2) + "\\n");
fs.renameSync(next, hooksPath);
console.log("Updated " + hooksPath);
${renderCursorWebToolsSetup(ctx)}
${CURSOR_STATE_DB_JS}
${renderCursorHelperToolAllowlist(ctx)}
${CURSOR_WEB_TOOLS_OFF_JS}`;
}

/**
 * The cleanup helper for this setup (see the payload). It is told the
 * deployment's addresses without the credentials their URLs may carry, and
 * the names this setup gives its two MCP servers.
 */
/**
 * The deployment's addresses, without the credentials their URLs may carry.
 * A Cursor setting that points at one of them is this deployment's own.
 */
function deploymentOrigins(ctx: SetupScriptContext): string[] {
  return [
    ...new Set(
      [
        ctx.deploymentOrigin,
        ctx.cursorGuardrailsHook?.url,
        ctx.mcp?.url,
        ctx.proxy?.url,
        ctx.skills?.cloneUrl,
      ].flatMap((url) => {
        try {
          return url ? [new URL(url).origin] : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

function renderCursorDisconnectHelper(ctx: SetupScriptContext): string {
  const origins = deploymentOrigins(ctx);
  return cursorDisconnectHelper({
    appName: ctx.appName,
    origins: [...new Set(origins)],
    servers: [
      ...(ctx.mcp ? [ctx.mcp.serverName, ...legacyServerNames(ctx.mcp)] : []),
      cursorWebServerName(ctx),
    ],
    tokenPrefixes: [...ALL_ARCHESTRA_TOKEN_PREFIXES],
  });
}

/** The name Cursor lists the web tools' server under, next to the gateway's. */
function cursorWebServerName(ctx: SetupScriptContext): string {
  return `${ctx.mcp?.serverName ?? "archestra"}-web`;
}

/**
 * Cursor's own web search and web fetch run without Guardrails and are
 * switched off below. Two tools of a local MCP server take their place: Cursor
 * calls the hook for them, and each runs the native web call through a
 * headless Cursor CLI process (see the payload).
 *
 * That process gets a home folder of its own with only the Guardrails hook
 * in it, and a working folder whose permission file denies everything but the
 * web call. The helper that installs and signs in Cursor's command-line agent
 * is written here too; the script a person runs calls it as its last step. The server's entry goes into ~/.cursor/mcp.json after the
 * gateway's; a file this step cannot read is left alone.
 */
function renderCursorWebToolsSetup(ctx: SetupScriptContext): string {
  return `const webTools = path.join(dir, ${JSON.stringify(CURSOR_WEB_TOOLS_FILENAME)});
fs.writeFileSync(webTools, ${JSON.stringify(CURSOR_WEB_TOOLS)});
fs.writeFileSync(path.join(dir, ${JSON.stringify(CURSOR_WEB_SIGN_IN_FILENAME)}), ${JSON.stringify(cursorWebSignInHelper({ appName: ctx.appName, gateway: ctx.mcp?.serverName ?? null }))});
const webCli = path.join(dir, ${JSON.stringify(CURSOR_WEB_CLI_DIRNAME)});
fs.mkdirSync(path.join(webCli, "home", ".cursor"), { recursive: true });
fs.mkdirSync(path.join(webCli, "workspace", ".cursor"), { recursive: true });
fs.writeFileSync(path.join(webCli, "workspace", ".cursor", "cli.json"), ${JSON.stringify(JSON.stringify(CURSOR_WEB_CLI_PERMISSIONS, null, 2))});
const webCliHooks = { version: 1, hooks: {} };
for (const step of ${JSON.stringify(CURSOR_GUARDRAILS_HOOK_STEPS)}) {
  webCliHooks.hooks[step] = [
    {
      command: runHelper + " " + step,
      timeout: ${CURSOR_GUARDRAILS_HOOK_TIMEOUT_SECONDS},
      ...(enforcing.includes(step) ? { failClosed: true } : {}),
    },
  ];
}
fs.writeFileSync(path.join(webCli, "home", ".cursor", "hooks.json"), JSON.stringify(webCliHooks, null, 2) + "\\n");
const webServerName = ${JSON.stringify(cursorWebServerName(ctx))};
// Cursor starts an MCP server with few environment variables. On Linux the
// CLI keeps its sign-in under XDG_CONFIG_HOME, so a value set in this shell
// goes into the entry; without it the server would look in ~/.config.
const webServer = {
  command: process.platform === "win32" ? "node" : process.execPath,
  args: [webTools],
  ...(process.platform === "linux" && process.env.XDG_CONFIG_HOME ? { env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } } : {}),
};
const mcpPath = path.join(os.homedir(), ".cursor", "mcp.json");
let mcpConfig = {};
let mcpReadable = true;
if (fs.existsSync(mcpPath)) {
  const raw = fs.readFileSync(mcpPath, "utf8").replace(/^\\uFEFF/, "").trim();
  if (raw) {
    try {
      mcpConfig = JSON.parse(raw);
    } catch {
      mcpReadable = false;
    }
  }
}
if (!mcpConfig || typeof mcpConfig !== "object" || Array.isArray(mcpConfig)) mcpReadable = false;
if (!mcpReadable) {
  console.log(mcpPath + " has comments or is not valid JSON, so setup left it alone. For web search and fetch that Guardrails check, add this server to its mcpServers by hand:");
  console.log("  " + JSON.stringify({ [webServerName]: webServer }));
} else {
  const servers = mcpConfig.mcpServers && typeof mcpConfig.mcpServers === "object" && !Array.isArray(mcpConfig.mcpServers) ? mcpConfig.mcpServers : {};
  if (JSON.stringify(servers[webServerName]) !== JSON.stringify(webServer)) {
${
  // The gateway's step keeps the person's own file before it adds its entry.
  ctx.mcp
    ? ""
    : `    if (fs.existsSync(mcpPath) && !fs.existsSync(mcpPath + ".archestra-backup")) fs.copyFileSync(mcpPath, mcpPath + ".archestra-backup");
`
}    mcpConfig.mcpServers = { ...servers, [webServerName]: webServer };
    const nextMcp = mcpPath + ".archestra-next";
    fs.writeFileSync(nextMcp, JSON.stringify(mcpConfig, null, 2) + "\\n");
    fs.renameSync(nextMcp, mcpPath);
    console.log("Added web search and fetch tools as \\"" + webServerName + "\\" in " + mcpPath);
  }
}`;
}

/** Where Cursor keeps its settings, when Cursor has run on this computer. */
const CURSOR_STATE_DB_JS = `const cursorStateDb =
  (process.platform === "win32"
    ? [path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "state.vscdb")]
    : [
        path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
        path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor", "User", "globalStorage", "state.vscdb"),
      ]
  ).find((candidate) => fs.existsSync(candidate)) || null;`;

/**
 * Cursor runs its Web Search and Web Fetch tools without calling any hook, so
 * a chat could read the web, or send a query to it, with nothing checked.
 * Setup switches the two tools off in Cursor's settings. The browser tool and
 * the terminal still reach the web, and both call the hook.
 *
 * Cursor writes its settings back when it quits, so a change made while it
 * runs is lost. Setup therefore waits for the person to quit Cursor, as the
 * Claude Desktop setup does, and names the two switches when it cannot make
 * the change itself. The values from before are kept in a row of their own.
 */
const CURSOR_WEB_TOOLS_OFF_JS = `const webToolsByHand = (why) =>
  console.log(why + " Switch off Web Search Tool and Web Fetch Tool in Cursor Settings: those two tools run without Guardrails.");
const cursorIsRunning = () => {
  const { execFileSync } = require("child_process");
  const found = (command, args) => {
    try {
      return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return "";
    }
  };
  return process.platform === "win32"
    ? /cursor\\.exe/i.test(found("tasklist", ["/FI", "IMAGENAME eq Cursor.exe", "/NH"]))
    : (found("pgrep", ["-x", "Cursor"]) + found("pgrep", ["-x", "cursor"])).trim() !== "";
};
const switchOffWebTools = () => {
  if (!cursorStateDb) return webToolsByHand("Cursor has not run on this computer yet, so setup could not change its settings.");
  let sqlite;
  try {
    process.emitWarning = () => {};
    sqlite = require("node:sqlite");
  } catch {
    return webToolsByHand("This Node.js cannot open Cursor's settings.");
  }
  if (cursorIsRunning()) {
    console.log("Quit Cursor to finish setup: Cursor keeps a settings change only when it is made while Cursor is closed. Waiting up to two minutes...");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let waited = 0; waited < 120 && cursorIsRunning(); waited++) Atomics.wait(pause, 0, 0, 1000);
    if (cursorIsRunning()) return webToolsByHand("Cursor is still running, so setup could not change its settings.");
  }
  try {
    const store = new sqlite.DatabaseSync(cursorStateDb);
    try {
      const read = store.prepare("SELECT value FROM ItemTable WHERE key = ?");
      const write = store.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
      const text = (row) => (row ? (ArrayBuffer.isView(row.value) ? Buffer.from(row.value).toString("utf8") : String(row.value)) : "");
      const user = JSON.parse(text(read.get(${JSON.stringify(CURSOR_APPLICATION_USER_KEY)})) || "null");
      const state = user && user.composerState && typeof user.composerState === "object" ? user.composerState : null;
      if (!state) return webToolsByHand("Setup could not find Cursor's tool settings.");
      // Cursor has renamed the search switch twice and reads the newest one,
      // taking a switch it does not find as on. So every name it has used is
      // switched off, whether or not the settings hold it yet, and any newer
      // numbered one that they do hold.
      const switches = [...new Set(["isWebSearchToolEnabled", "isWebSearchToolEnabled2", "isWebSearchToolEnabled3", ...Object.keys(state).filter((key) => /^isWebSearchToolEnabled\\d+$/.test(key)), "isWebFetchToolEnabled"])];
      if (switches.every((key) => state[key] === false)) return;
      if (!read.get(${JSON.stringify(CURSOR_WEB_TOOLS_KEY)}))
        write.run(${JSON.stringify(CURSOR_WEB_TOOLS_KEY)}, JSON.stringify(Object.fromEntries(switches.map((key) => [key, state[key] ?? null]))));
      for (const key of switches) state[key] = false;
      write.run(${JSON.stringify(CURSOR_APPLICATION_USER_KEY)}, JSON.stringify(user));
      console.log("Switched off Cursor's Web Search and Web Fetch tools, which run without Guardrails. Cursor's browser tool and the terminal still reach the web, and Guardrails check them.");
    } finally {
      store.close();
    }
  } catch {
    webToolsByHand("Setup could not change Cursor's settings.");
  }
};
switchOffWebTools();`;

/**
 * The gateway tools setup puts on Cursor's MCP allowlist, without the tool
 * prefix: the tool search and the tool runner, through which every other
 * gateway tool is found and called, the Guardrails helpers, and `ask_user`.
 * The same set Claude Code's setup pre-approves, plus the search Cursor would
 * otherwise ask about each time.
 */
const CURSOR_ALLOWLISTED_TOOL_NAMES: readonly string[] = [
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  ...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
];

/**
 * Cursor asks the person before it runs an MCP tool that is not on its
 * allowlist, and no hook can answer that prompt. A chat waits at each prompt
 * until someone clicks, and a prompt in the middle of a remedy doubles the
 * policy's own question. The gateway enforces access rules and Guardrails on
 * every call either way, so its tool search, tool runner and Guardrails
 * helpers go on the allowlist.
 *
 * The list in ~/.cursor/permissions.json replaces the one in Cursor's
 * settings as soon as the file defines it. So a file that has no list yet
 * gets the settings' entries too, read from Cursor's settings database, and
 * when those cannot be read the file is left alone and the person gets the
 * entries to add by hand.
 */
function renderCursorHelperToolAllowlist(ctx: SetupScriptContext): string {
  const tools = [
    ...(ctx.mcp
      ? CURSOR_ALLOWLISTED_TOOL_NAMES.map(
          (tool) => `${ctx.mcp?.serverName}:${ctx.mcp?.toolPrefix}${tool}`,
        )
      : []),
    // Guardrails rule on each web call; a second prompt from Cursor adds nothing.
    ...[
      CURSOR_WEB_SETUP_TOOL,
      CURSOR_WEB_SEARCH_TOOL,
      CURSOR_WEB_FETCH_TOOL,
    ].map((tool) => `${cursorWebServerName(ctx)}:${tool}`),
  ];
  return `const helperTools = ${JSON.stringify(tools)};
const permissionsPath = path.join(os.homedir(), ".cursor", "permissions.json");
const byHand = (why) => {
  console.log(why + " To stop Cursor's own prompt for these tools, add them under Cursor Settings > MCP allowlist:");
  for (const tool of helperTools) console.log("  " + tool);
};
const settingsAllowlist = () => {
  const db = cursorStateDb;
  // Cursor has not run yet: its settings hold no list.
  if (!db) return [];
  try {
    process.emitWarning = () => {};
    const { DatabaseSync } = require("node:sqlite");
    const store = new DatabaseSync(db, { readOnly: true });
    try {
      const row = store.prepare("SELECT value FROM ItemTable WHERE key = ?").get(${JSON.stringify(CURSOR_APPLICATION_USER_KEY)});
      const list = row ? JSON.parse(String(row.value))?.composerState?.mcpAllowedTools : [];
      return Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : [];
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
};
let permissions = {};
let permissionsReadable = true;
if (fs.existsSync(permissionsPath)) {
  try {
    permissions = JSON.parse(fs.readFileSync(permissionsPath, "utf8").replace(/^\\uFEFF/, ""));
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) permissionsReadable = false;
  } catch {
    permissionsReadable = false;
  }
}
if (!permissionsReadable) {
  byHand(permissionsPath + " has comments or is not valid JSON, so setup left it alone.");
} else {
  const listed = Array.isArray(permissions.mcpAllowlist) ? permissions.mcpAllowlist : null;
  const carried = listed ? [] : settingsAllowlist();
  if (carried === null) {
    byHand("Setup could not read the MCP allowlist in Cursor's settings, so it left " + permissionsPath + " alone.");
  } else {
    const known = new Set((listed || carried).map((entry) => String(entry).toLowerCase()));
    const added = helperTools.filter((tool) => !known.has(tool.toLowerCase()));
    if (added.length > 0 || !listed) {
      if (fs.existsSync(permissionsPath) && !fs.existsSync(permissionsPath + ".archestra-backup"))
        fs.copyFileSync(permissionsPath, permissionsPath + ".archestra-backup");
      permissions.mcpAllowlist = [...(listed || carried), ...added];
      const nextPermissions = permissionsPath + ".archestra-next";
      fs.writeFileSync(nextPermissions, JSON.stringify(permissions, null, 2) + "\\n");
      fs.renameSync(nextPermissions, permissionsPath);
      console.log("Updated " + permissionsPath);
      if (carried.length > 0)
        console.log("Cursor now reads its MCP allowlist from that file. The " + carried.length + " tools you allowed in Cursor's settings were copied into it.");
    }
  }
}`;
}

const cursorGuardrailsHookScript = nodeScriptRenderers(
  renderCursorGuardrailsHookSetup,
);

function cursorBashSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp && ctx.runtimeHandoffInstructions) {
    sections.push(`say ${sh("Runtime handoff instructions — copy into Cursor User Rules")}
printf '%s\\n' ${sh(ctx.runtimeHandoffInstructions)}`);
  }

  if (ctx.mcp) {
    sections.push(`say ${sh(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
${mergeJsonFileBash({
  file: "$HOME/.cursor/mcp.json",
  env: {
    ARCHESTRA_MCP_SERVER_NAME: ctx.mcp.serverName,
    ARCHESTRA_MCP_SERVER_URL: ctx.mcp.url,
    ARCHESTRA_MCP_LEGACY_NAMES: JSON.stringify(legacyServerNames(ctx.mcp)),
  },
  python: CURSOR_MCP_MERGE_PY,
  fallbackMessage:
    "python3 not found — merge this into ~/.cursor/mcp.json manually:",
  fallbackSnippet: JSON.stringify(
    { mcpServers: { [ctx.mcp.serverName]: { url: ctx.mcp.url } } },
    null,
    2,
  ),
})}`);
  }

  if (ctx.cursorGuardrailsHook) {
    sections.push(`say ${sh(`Turning on ${ctx.appName} Guardrails for Cursor chats`)}
${cursorGuardrailsHookScript.bash.sections(ctx)[0]}`);
    if (ctx.cursorGuardrailsHook.finishWebSetup) {
      sections.push(`say ${sh(CURSOR_WEB_SETUP_HEADING)}
node "$HOME/.cursor/archestra/${CURSOR_WEB_SIGN_IN_FILENAME}" </dev/null || warn ${sh(CURSOR_WEB_SETUP_UNFINISHED)}`);
    }
  }

  if (ctx.proxy) {
    sections.push(cursorModelSettingsBash(ctx, ctx.proxy));
  } else {
    // Whatever else the setup includes: a person who leaves the LLM proxy
    // out gets Cursor's own models back.
    sections.push(cursorPlanModelsBash(ctx));
  }

  if (ctx.skills) {
    sections.push(`say ${sh(`Installing ${describeMarketplaceContents(ctx.skills).label} for Cursor`)}
CURSOR_SKILLS_DIR="$HOME/.cursor/skills/${ctx.skills.marketplaceName}"
cursor_skills_installed=0
cursor_skills_edited=0
if command -v git >/dev/null 2>&1; then
  if [ -d "$CURSOR_SKILLS_DIR/.git" ]; then
    if git -C "$CURSOR_SKILLS_DIR" remote set-url origin ${sh(ctx.skills.cloneUrl)} && git -C "$CURSOR_SKILLS_DIR" fetch -q origin; then
      if git -C "$CURSOR_SKILLS_DIR" merge --ff-only -q '@{u}' >/dev/null 2>&1; then
        cursor_skills_installed=1
      # A rebuilt marketplace has new history. Follow it unless the folder has
      # local edits; the old commits stay in the reflog.
      elif cursor_skills_edits=$(git -C "$CURSOR_SKILLS_DIR" status --porcelain); then
        if [ -n "$cursor_skills_edits" ]; then
          cursor_skills_edited=1
        elif git -C "$CURSOR_SKILLS_DIR" reset -q --hard '@{u}'; then
          cursor_skills_installed=1
        fi
      fi
    fi
  elif [ ! -e "$CURSOR_SKILLS_DIR" ]; then
    mkdir -p "$(dirname "$CURSOR_SKILLS_DIR")"
    if git clone -q ${sh(ctx.skills.cloneUrl)} "$CURSOR_SKILLS_DIR"; then
      cursor_skills_installed=1
    fi
  else
    warn ${sh("Cursor skills folder already exists and is not a Git repository.")}
  fi
else
  warn ${sh("git is not installed. Install git to fetch shared skills for Cursor.")}
fi
if [ "$cursor_skills_installed" -eq 1 ]; then
  ok ${sh(`Cursor skills installed in ~/.cursor/skills/${ctx.skills.marketplaceName}.`)}
elif [ "$cursor_skills_edited" -eq 1 ]; then
  warn ${sh(`Cursor skills were not updated: the marketplace history changed, and ~/.cursor/skills/${ctx.skills.marketplaceName} has local edits. Move the folder aside and run setup again.`)}
else
  warn ${sh("Cursor skills installation failed. Retry after checking git access to the marketplace.")}
cat <<'ARCHESTRA_CURSOR_SKILLS'

Clone the marketplace into ~/.cursor/skills/${ctx.skills.marketplaceName}:
  git clone ${sh(ctx.skills.cloneUrl)} "$HOME/.cursor/skills/${ctx.skills.marketplaceName}"
ARCHESTRA_CURSOR_SKILLS
fi
cat <<'ARCHESTRA_CURSOR_SKILLS'

Reload Cursor and open Customize > Skills to confirm the shared skills are available.
ARCHESTRA_CURSOR_SKILLS`);
  }

  return sections;
}

function cursorPowerShellSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp && ctx.runtimeHandoffInstructions) {
    sections.push(`Say ${psq("Runtime handoff instructions — copy into Cursor User Rules")}
Write-Host ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(ctx.runtimeHandoffInstructions).toString("base64")}')))`);
  }

  if (ctx.mcp) {
    sections.push(`Say ${psq(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
$arch_path = Join-Path $env:USERPROFILE '.cursor\\mcp.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $arch_path) | Out-Null
if ((Test-Path $arch_path) -and -not (Test-Path ($arch_path + '.archestra-backup'))) {
  Copy-Item -Path $arch_path -Destination ($arch_path + '.archestra-backup')
}
$arch_config = [pscustomobject]@{}
if (Test-Path $arch_path) {
  $arch_raw = Get-Content -Raw -Path $arch_path
  if ($arch_raw -and $arch_raw.Trim()) { $arch_config = $arch_raw | ConvertFrom-Json }
}
if (-not $arch_config.PSObject.Properties['mcpServers']) { $arch_config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) }
$arch_servers = $arch_config.mcpServers
$arch_server_name = ${psq(ctx.mcp.serverName)}
$arch_entry = [pscustomobject]@{ url = ${psq(ctx.mcp.url)} }
foreach ($arch_legacy in @(${legacyServerNames(ctx.mcp).map(psq).join(", ") || "''"})) {
  if ($arch_legacy -and $arch_servers.PSObject.Properties[$arch_legacy]) { $arch_servers.PSObject.Properties.Remove($arch_legacy) }
}
if ($arch_servers.PSObject.Properties[$arch_server_name]) { $arch_servers.$arch_server_name = $arch_entry } else { $arch_servers | Add-Member -NotePropertyName $arch_server_name -NotePropertyValue $arch_entry }
$arch_config | ConvertTo-Json -Depth 32 | Set-Content -Path $arch_path -Encoding utf8
Write-Host ('Updated ' + $arch_path)`);
  }

  if (ctx.cursorGuardrailsHook) {
    sections.push(`Say ${psq(`Turning on ${ctx.appName} Guardrails for Cursor chats`)}
${cursorGuardrailsHookScript.powerShell.sections(ctx)[0]}`);
    if (ctx.cursorGuardrailsHook.finishWebSetup) {
      // Under 'Continue': Windows PowerShell 5.1 turns a native command's
      // stderr into a terminating error under 'Stop'.
      sections.push(`Say ${psq(CURSOR_WEB_SETUP_HEADING)}
$cursorWebSetup = & {
  $ErrorActionPreference = 'Continue'
  & node (Join-Path $env:USERPROFILE ${psq(`.cursor\\archestra\\${CURSOR_WEB_SIGN_IN_FILENAME}`)}) | Out-Host
  $LASTEXITCODE
}
if ($cursorWebSetup -ne 0) { Warn ${psq(CURSOR_WEB_SETUP_UNFINISHED)} }`);
    }
  }

  if (ctx.proxy) {
    sections.push(cursorModelSettingsPowerShell(ctx, ctx.proxy));
  } else {
    sections.push(cursorPlanModelsPowerShell(ctx));
  }

  if (ctx.skills) {
    const pluginNames = ctx.skills.pluginNames ?? [];
    sections.push(`Say ${psq(`Installing ${describeMarketplaceContents(ctx.skills).label} for Cursor`)}
$cursorSkillsDir = Join-Path $env:USERPROFILE ${psq(`.cursor/skills/${ctx.skills.marketplaceName}`)}
$cursorSkillsState = 'failed'
if (Get-Command git -ErrorAction SilentlyContinue) {
  # git runs under 'Continue': Windows PowerShell 5.1 turns its stderr into a
  # terminating error under 'Stop', even when the stream is redirected.
  if (Test-Path (Join-Path $cursorSkillsDir '.git')) {
    $cursorSkillsState = & {
      $ErrorActionPreference = 'Continue'
      & git -C $cursorSkillsDir remote set-url origin ${psq(ctx.skills.cloneUrl)} *> $null
      if ($LASTEXITCODE -ne 0) { return 'failed' }
      & git -C $cursorSkillsDir fetch -q origin *> $null
      if ($LASTEXITCODE -ne 0) { return 'failed' }
      & git -C $cursorSkillsDir merge --ff-only -q '@{u}' *> $null
      if ($LASTEXITCODE -eq 0) { return 'installed' }
      # A rebuilt marketplace has new history. Follow it unless the folder has
      # local edits; the old commits stay in the reflog.
      $cursorSkillsEdits = & git -C $cursorSkillsDir status --porcelain 2> $null
      if ($LASTEXITCODE -ne 0) { return 'failed' }
      if ($cursorSkillsEdits) { return 'edited' }
      & git -C $cursorSkillsDir reset -q --hard '@{u}' *> $null
      if ($LASTEXITCODE -eq 0) { 'installed' } else { 'failed' }
    }
  } elseif (-not (Test-Path $cursorSkillsDir)) {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cursorSkillsDir)
    $cursorSkillsState = & {
      $ErrorActionPreference = 'Continue'
      & git clone -q ${psq(ctx.skills.cloneUrl)} $cursorSkillsDir *> $null
      if ($LASTEXITCODE -eq 0) { 'installed' } else { 'failed' }
    }
  } else {
    Warn ${psq("Cursor skills folder already exists and is not a Git repository.")}
  }
} else {
  Warn ${psq("git is not installed. Install git to fetch shared skills for Cursor.")}
}
if ($cursorSkillsState -eq 'installed') {
  Ok ${psq(`Cursor skills installed in ~/.cursor/skills/${ctx.skills.marketplaceName}.`)}
} elseif ($cursorSkillsState -eq 'edited') {
  Warn ${psq(`Cursor skills were not updated: the marketplace history changed, and ~/.cursor/skills/${ctx.skills.marketplaceName} has local edits. Move the folder aside and run setup again.`)}
} else {
  Warn ${psq("Cursor skills installation failed. Retry after checking git access to the marketplace.")}
Write-Host @'

Clone the marketplace into ~/.cursor/skills/${ctx.skills.marketplaceName}:
  git clone ${psq(ctx.skills.cloneUrl)} "$HOME/.cursor/skills/${ctx.skills.marketplaceName}"
'@
}
Write-Host @'

Reload Cursor and open Customize > Skills to confirm the shared skills are available.
${
  pluginNames.length > 0
    ? `
Then install these plugins from Customize -> Plugins:
  ${pluginNames.join("\n  ")}`
    : ""
}
'@`);
  }

  return sections;
}

// The last step of the Guardrails setup: the web tools run through Cursor's
// command-line agent, so the helper installs it when it is missing and signs
// it in. A step that does not finish leaves the rest of the setup in place;
// the tools then say what is missing, and their setup tool does the same work
// from a chat.
const CURSOR_WEB_SETUP_HEADING =
  "Getting web search and fetch ready for Cursor chats";
const CURSOR_WEB_SETUP_UNFINISHED = `Web search and fetch are not ready yet. Ask Cursor to run its ${CURSOR_WEB_SETUP_TOOL} tool, or run: node ~/.cursor/archestra/${CURSOR_WEB_SIGN_IN_FILENAME}`;

// Silent unless an earlier setup routed Cursor's models: there is nothing to
// say to a person whose Cursor never changed.
function cursorPlanModelsBash(ctx: SetupScriptContext): string {
  return `cursor_state_db=""
for arch_candidate in "$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb" "\${XDG_CONFIG_HOME:-$HOME/.config}/Cursor/User/globalStorage/state.vscdb"; do
  if [ -f "$arch_candidate" ]; then cursor_state_db="$arch_candidate"; break; fi
done
if [ -n "$cursor_state_db" ] && command -v python3 >/dev/null 2>&1; then
  if [ "$(ARCHESTRA_CURSOR_STATE_DB="$cursor_state_db" python3 - 2>/dev/null <<'ARCHESTRA_CURSOR_PY'
${cursorPlanModelsPy(deploymentOrigins(ctx))}
ARCHESTRA_CURSOR_PY
  )" = "restored" ]; then
    ok ${sh("Cursor uses its own models again. Quit and reopen Cursor to load the change.")}
  fi
fi`;
}

function cursorPlanModelsPowerShell(ctx: SetupScriptContext): string {
  return `$cursorStateDb = Join-Path $env:APPDATA 'Cursor/User/globalStorage/state.vscdb'
$cursorPython = @('python3', 'python', 'py') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if ((Test-Path $cursorStateDb) -and $cursorPython) {
  $env:ARCHESTRA_CURSOR_STATE_DB = $cursorStateDb
  # Python's stderr would abort Windows PowerShell 5.1 under 'Stop'.
  $cursorPlanRestored = & {
    $ErrorActionPreference = 'Continue'
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(cursorPlanModelsPy(deploymentOrigins(ctx))).toString("base64")}')) | & $cursorPython - 2>$null
  }
  if ("$cursorPlanRestored".Trim() -eq 'restored') {
    Ok ${psq("Cursor uses its own models again. Quit and reopen Cursor to load the change.")}
  }
}`;
}

function cursorModelSettingsBash(
  ctx: SetupScriptContext,
  proxy: SetupScriptProxySection,
): string {
  if (!proxy.virtualKey) {
    return `say ${sh("Cursor model settings")}
warn ${sh("This setup has no virtual key for Cursor. Generate a new setup command to route Cursor's models.")}`;
  }
  const manual = manualModelSettings({
    url: proxy.url,
    virtualKey: proxy.virtualKey,
  });
  return `say ${sh(`Routing Cursor's models through ${ctx.appName}`)}
cursor_state_db=""
for arch_candidate in "$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb" "\${XDG_CONFIG_HOME:-$HOME/.config}/Cursor/User/globalStorage/state.vscdb"; do
  if [ -f "$arch_candidate" ]; then cursor_state_db="$arch_candidate"; break; fi
done
cursor_models_set=0
if [ -n "$cursor_state_db" ] && command -v python3 >/dev/null 2>&1; then
  if ARCHESTRA_CURSOR_STATE_DB="$cursor_state_db" ARCHESTRA_CURSOR_BASE_URL=${sh(proxy.url)} ARCHESTRA_CURSOR_API_KEY=${sh(proxy.virtualKey)} ARCHESTRA_CURSOR_MODELS=${sh(JSON.stringify(proxy.cursorModels ?? null))} python3 - <<'ARCHESTRA_CURSOR_PY'
${CURSOR_MODEL_SETTINGS_PY}
ARCHESTRA_CURSOR_PY
  then
    cursor_models_set=1
  fi
fi
if [ "$cursor_models_set" -eq 1 ]; then
  ok ${sh(`Cursor's OpenAI API key settings now point at ${ctx.appName}.`)}
  if pgrep -x Cursor >/dev/null 2>&1 || pgrep -x cursor >/dev/null 2>&1; then
    warn ${sh("Quit and reopen Cursor to load the new model settings.")}
  fi
else
  warn ${sh("Could not update Cursor's settings automatically (open Cursor once first, and install python3). Enter them by hand:")}
cat <<'ARCHESTRA_CURSOR'
${manual}
ARCHESTRA_CURSOR
fi`;
}

function cursorModelSettingsPowerShell(
  ctx: SetupScriptContext,
  proxy: SetupScriptProxySection,
): string {
  if (!proxy.virtualKey) {
    return `Say ${psq("Cursor model settings")}
Warn ${psq("This setup has no virtual key for Cursor. Generate a new setup command to route Cursor's models.")}`;
  }
  const manual = manualModelSettings({
    url: proxy.url,
    virtualKey: proxy.virtualKey,
  });
  return `Say ${psq(`Routing Cursor's models through ${ctx.appName}`)}
$cursorStateDb = Join-Path $env:APPDATA 'Cursor/User/globalStorage/state.vscdb'
$cursorPython = @('python3', 'python', 'py') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
$cursorModelsSet = $false
if ((Test-Path $cursorStateDb) -and $cursorPython) {
  $env:ARCHESTRA_CURSOR_STATE_DB = $cursorStateDb
  $env:ARCHESTRA_CURSOR_BASE_URL = ${psq(proxy.url)}
  $env:ARCHESTRA_CURSOR_API_KEY = ${psq(proxy.virtualKey)}
  $env:ARCHESTRA_CURSOR_MODELS = ${psq(JSON.stringify(proxy.cursorModels ?? null))}
  # Python's stderr would abort Windows PowerShell 5.1 under 'Stop'.
  $cursorModelsSet = & {
    $ErrorActionPreference = 'Continue'
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(CURSOR_MODEL_SETTINGS_PY).toString("base64")}')) | & $cursorPython - *> $null
    $LASTEXITCODE -eq 0
  }
  Remove-Item Env:ARCHESTRA_CURSOR_API_KEY -ErrorAction SilentlyContinue
}
if ($cursorModelsSet) {
  Ok ${psq(`Cursor's OpenAI API key settings now point at ${ctx.appName}.`)}
  if (Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue) {
    Warn ${psq("Quit and reopen Cursor to load the new model settings.")}
  }
} else {
  Warn ${psq("Could not update Cursor's settings automatically (open Cursor once first, and install Python). Enter them by hand:")}
Write-Host @'
${manual}
'@
}`;
}

/** The fallback when the settings store can't be written. */
function manualModelSettings(params: {
  url: string;
  virtualKey: string;
}): string {
  return `
In Cursor: Settings -> Models -> API Keys -> OpenAI API Key
  1. Turn on "Override OpenAI Base URL" and paste: ${params.url}
  2. Paste this key into the API Key field and turn on "Use OpenAI API Key":
     ${params.virtualKey}`;
}

function cursorEnding(ctx: SetupScriptContext): AgentEnding {
  const notes: string[] = [];
  if (ctx.skills) {
    notes.push("Reload Cursor to load the shared skills (Customize > Skills).");
    if (ctx.skills.pluginNames?.length) {
      notes.push(
        `Install these plugins from Customize > Plugins: ${ctx.skills.pluginNames.join(", ")}.`,
      );
    }
  }
  notes.push(
    ctx.mcp && ctx.runtimeHandoffInstructions
      ? "Paste the handoff instructions printed above into Cursor Customize > Rules > User Rules, next to your own rules."
      : `If you pasted ${ctx.appName} handoff instructions into Cursor User Rules before, you can remove them.`,
  );
  if (ctx.cursorGuardrailsHook) {
    notes.push(
      ctx.proxy
        ? `${ctx.appName} Guardrails check every Cursor chat that runs on this computer. Quit and reopen Cursor to load the hooks in ~/.cursor/hooks.json.`
        : `Cursor keeps its own models and your Cursor plan. ${ctx.appName} Guardrails check every chat that runs on this computer, through hooks in ~/.cursor/hooks.json. Quit and reopen Cursor to load them.`,
    );
  }
  if (ctx.cursorGuardrailsHook) {
    notes.push(
      `Web search and fetch in a Cursor chat now run as the tools ${CURSOR_WEB_SEARCH_TOOL} and ${CURSOR_WEB_FETCH_TOOL}, which ${ctx.appName} Guardrails check. They run through Cursor's command-line agent on your Cursor plan. If it is ever missing or signed out, ask Cursor to run its ${CURSOR_WEB_SETUP_TOOL} tool.`,
    );
  }
  if (ctx.mcp || ctx.cursorGuardrailsHook) {
    // A chat with no folder open starts on Cloud, where neither exists.
    notes.push(
      `Open a folder before you start a chat, and keep the chat on this computer, not on Cloud. A Cloud chat runs on Cursor's servers, without ${ctx.appName}'s tools or Guardrails.`,
    );
  }
  if (ctx.proxy?.virtualKey) {
    notes.push(
      ctx.proxy.cursorModels?.ids.length
        ? `Cursor's model picker now lists only ${ctx.appName} models; its built-in models are switched off, because Cursor's own models do not run while its OpenAI API key setting is on.`
        : `Add models in Cursor Settings > Models by their ${ctx.appName} id, such as anthropic:<model>. ${ctx.proxy.url}/models lists them.`,
    );
  }
  return {
    proxyDetail: `Cursor's models use the ${ctx.appName} Model Router (Settings > Models > API Keys)`,
    signIn: ctx.mcp
      ? {
          command: null,
          howTo: `In Cursor, open Customize > MCPs and sign in to "${ctx.mcp.serverName}".`,
        }
      : null,
    launch: null,
    notes,
  };
}

export const cursorSetup: ShellAgentSetup = {
  label: "Cursor",
  bash: { sections: cursorBashSections },
  powerShell: {
    sections: cursorPowerShellSections,
  },
  ending: cursorEnding,
};
