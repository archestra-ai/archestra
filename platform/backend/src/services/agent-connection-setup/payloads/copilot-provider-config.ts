import { COPILOT_LEGACY_PROVIDER_ENV_VARS } from "@archestra/shared";

const LEGACY_NAMES = COPILOT_LEGACY_PROVIDER_ENV_VARS.join("|");

/**
 * A shell-profile line that exports one of Copilot's provider variables
 * (bash/zsh `export NAME=…`, fish `set -gx NAME …`). Extended regex for
 * grep/awk. Copilot CLI uses these variables instead of providers.json, and
 * with only COPILOT_MODEL set it refuses to start the saved model, so setup,
 * the launch check and disconnect all remove the lines an Archestra setup
 * wrote.
 */
export const COPILOT_LEGACY_EXPORT_LINE_PATTERN = `^[[:space:]]*(export[[:space:]]+(${LEGACY_NAMES})=|set[[:space:]]+-gx[[:space:]]+(${LEGACY_NAMES})[[:space:]])`;

/**
 * The lines that prove a profile's provider variables came from an Archestra
 * setup (its instructions, or an older setup that wrote them): a connection
 * setup URL, an Archestra attribution header, a virtual key, or a prefixed
 * model. A profile without one keeps its lines; the closing note reports them.
 */
export const COPILOT_LEGACY_EXPORT_OURS_PATTERN = `(COPILOT_PROVIDER_BASE_URL(=|[[:space:]]+)['"]?[^'"[:space:]]*/v1/connection-setup/|COPILOT_PROVIDER_HEADERS(=|[[:space:]]+)['"]?[^'"]*X-Archestra-|COPILOT_PROVIDER_API_KEY(=|[[:space:]]+)['"]?arch_|COPILOT_MODEL(=|[[:space:]]+)['"]?archestra/)`;

/**
 * Bash that deletes every line matching `$patternVar` (a shell variable
 * holding an extended regex) from the user's shell profiles, in place. With
 * `onlyIfVar`, a profile is touched only when a line matches that second
 * regex too. Sets `archestra_profile_lines_removed=1` when a line went. Fails
 * the caller on a profile it cannot rewrite.
 */
export function copilotStripProfileLinesBash(
  patternVar: string,
  onlyIfVar?: string,
): string {
  return `for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login" "\${ZDOTDIR:-$HOME}/.zshrc" "\${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" "\${XDG_CONFIG_HOME:-$HOME/.config}"/fish/conf.d/*.fish; do
    [ -f "$profile" ] || continue${
      onlyIfVar
        ? `
    grep -Eq "$${onlyIfVar}" "$profile" || continue`
        : ""
    }
    grep -Eq "$${patternVar}" "$profile" || continue
    awk -v pattern="$${patternVar}" '$0 !~ pattern { print }' "$profile" > "$profile.archestra-tmp" && cat "$profile.archestra-tmp" > "$profile" && rm "$profile.archestra-tmp" || return 1
    archestra_profile_lines_removed=1
  done`;
}

/**
 * Shell (bash and zsh) that leaves the names of the Copilot provider
 * variables set in the environment in `resultVar`, each preceded by a space.
 */
export function copilotLegacyEnvSetShell(resultVar: string): string {
  return [
    `${resultVar}=''`,
    `for archestra_copilot_var in ${COPILOT_LEGACY_PROVIDER_ENV_VARS.join(" ")}; do`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the emitted script
    '  eval "archestra_copilot_val=\\${$archestra_copilot_var:-}"',
    `  [ -z "$archestra_copilot_val" ] || ${resultVar}="$${resultVar} $archestra_copilot_var"`,
    "done",
    "unset archestra_copilot_var archestra_copilot_val",
  ].join("\n");
}

/**
 * Shell that sets `resultVar` to 1 when the environment's Copilot provider
 * variables came from an Archestra setup (see
 * COPILOT_LEGACY_EXPORT_OURS_PATTERN for the markers).
 */
export function copilotLegacyEnvOursShell(resultVar: string): string {
  return [
    `${resultVar}=0`,
    `case "\${COPILOT_PROVIDER_BASE_URL:-}" in */v1/connection-setup/*) ${resultVar}=1 ;; esac`,
    `case "\${COPILOT_PROVIDER_HEADERS:-}" in *X-Archestra-*) ${resultVar}=1 ;; esac`,
    `case "\${COPILOT_PROVIDER_API_KEY:-}" in arch_*) ${resultVar}=1 ;; esac`,
    `case "\${COPILOT_MODEL:-}" in archestra/*) ${resultVar}=1 ;; esac`,
  ].join("\n");
}

/** The `env -u NAME …` prefix that launches Copilot without its provider variables. */
export const COPILOT_LEGACY_ENV_UNSET_ARGS =
  COPILOT_LEGACY_PROVIDER_ENV_VARS.map((name) => `-u ${name}`).join(" ");

/** PowerShell array literal of the provider variable names. */
export const COPILOT_LEGACY_ENV_PS_ARRAY = `@(${COPILOT_LEGACY_PROVIDER_ENV_VARS.map((name) => `'${name}'`).join(", ")})`;

/**
 * Reads and writes Copilot's JSON files: `read` returns {} for a missing file
 * and tolerates comments and trailing commas where Copilot does (`jsonc`);
 * `write` replaces the file atomically, through a symlink to its target.
 */
const COPILOT_JSON_FILES_NODE = String.raw`function read(file, jsonc = false) {
  if (!fs.existsSync(file)) return {};
  let text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (jsonc) {
    text = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
      token => token.startsWith("/") ? token.replace(/[^\r\n]/g, " ") : token);
    text = text.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g,
      token => token === "," ? "" : token);
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(file + " must contain a JSON object");
  return value;
}
function write(file, value) {
  if (fs.existsSync(file)) file = fs.realpathSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".archestra-tmp-" + process.pid;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}`;

/**
 * Native Copilot registry configuration, shared by Bash/PowerShell setup and
 * disconnect. Verified against Copilot CLI 1.0.95 with a local HTTP provider.
 * Credentials enter through the environment, never command-line arguments.
 */
export const COPILOT_PROVIDER_CONFIG_NODE = String.raw`const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const registryPath = process.env.COPILOT_PROVIDERS_CONFIG?.trim() || path.join(home, "providers.json");
const settingsPath = path.join(home, "settings.json");
const statePath = registryPath + ".archestra-state.json";
const action = process.env.ARCHESTRA_COPILOT_ACTION;
const input = JSON.parse(process.env.ARCHESTRA_COPILOT_CONFIG || "{}");
const providerName = "archestra";
${COPILOT_JSON_FILES_NODE}
function backup(file) {
  if (fs.existsSync(file) && !fs.existsSync(file + ".archestra-backup")) {
    fs.copyFileSync(file, file + ".archestra-backup", fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file + ".archestra-backup", 0o600);
  }
}
const registry = read(registryPath);
for (const key of ["providers", "models"]) {
  if (registry[key] !== undefined && !Array.isArray(registry[key])) throw new Error(registryPath + ": " + key + " must be an array");
}
const providers = registry.providers || [];
const models = registry.models || [];
const existing = providers.find(provider => provider.name === providerName);
const state = read(statePath);
if (action === "install") {
  const version = (process.env.ARCHESTRA_COPILOT_VERSION || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version || (Number(version[1]) < 1) ||
      (Number(version[1]) === 1 && Number(version[2]) === 0 && Number(version[3]) < 95)) {
    throw new Error("Copilot CLI 1.0.95 or newer is required for providers.json setup. Update Copilot and re-run setup.");
  }
  if (existing && (!state.installedModel || existing.baseUrl !== state.url)) throw new Error("The archestra provider already exists or was changed outside setup; rename it before reconnecting.");
  const settings = read(settingsPath, true);
  const model = input.model;
  const selectedModel = providerName + "/" + model;
  const provider = { name: providerName, type: "openai", baseUrl: input.url,
    headers: input.headers, ...(input.wireApi ? { wireApi: input.wireApi } : {}) };
  const key = process.env.ARCHESTRA_COPILOT_API_KEY ||
    (existing?.baseUrl === input.url ? existing.apiKey : undefined);
  if (key) provider.apiKey = key;
  const nextState = { previousModel: state.installedModel && settings.model === state.installedModel ? state.previousModel : settings.model ?? null,
    installedModel: selectedModel, url: input.url };
  registry.providers = [...providers.filter(provider => provider.name !== providerName), provider];
  registry.models = [...models.filter(model => model.provider !== providerName),
    { id: model, provider: providerName, modelId: model, wireModel: model }];
  settings.model = selectedModel;
  backup(registryPath);
  backup(settingsPath);
  write(statePath, nextState);
  write(registryPath, registry);
  write(settingsPath, settings);
  console.log("Saved Copilot provider settings to " + registryPath);
  console.log("Selected " + selectedModel + " in " + settingsPath);
  if (!key) console.log("No API key was available. Add your provider key as apiKey in providers.json before launching Copilot.");
} else if (action === "remove") {
  if (state.installedModel && state.url === input.url && (!existing || existing.baseUrl === input.url)) {
    const settings = read(settingsPath, true);
    registry.providers = providers.filter(provider => provider.name !== providerName);
    registry.models = models.filter(model => model.provider !== providerName);
    write(registryPath, registry);
    if (settings.model === state.installedModel) {
      if (state.previousModel === null) delete settings.model;
      else settings.model = state.previousModel;
      write(settingsPath, settings);
    }
    fs.unlinkSync(statePath);
  }
} else {
  throw new Error("Unknown Copilot configuration action");
}
`;

/**
 * Points Copilot's registration of the skills marketplace at this setup's
 * clone URL. Copilot keeps it in settings.json under `extraKnownMarketplaces`
 * and `copilot plugin marketplace add` refuses a name it already holds, so a
 * setup run again would leave the URL an earlier setup wrote, with that
 * setup's credential, and every refresh fails once that credential stops
 * working. `copilot plugin marketplace remove` uninstalls the plugins
 * installed from the marketplace, so the URL is replaced in place instead.
 * Prints `absent`, `current`, `updated`, or `unknown` when settings.json
 * cannot be read or written. The URL carries the credential: it enters
 * through the environment and is never printed.
 */
export const COPILOT_MARKETPLACE_SOURCE_NODE = `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const settingsPath = path.join(home, "settings.json");
const name = process.env.ARCHESTRA_MARKETPLACE_NAME;
const url = process.env.ARCHESTRA_MARKETPLACE_URL;
${COPILOT_JSON_FILES_NODE}
let outcome = "unknown";
try {
  if (!name || !url) throw new Error("the marketplace name and URL are required");
  const settings = read(settingsPath, true);
  const marketplaces = settings.extraKnownMarketplaces;
  const entry = marketplaces && typeof marketplaces === "object" && !Array.isArray(marketplaces)
    ? marketplaces[name] : undefined;
  if (!entry || typeof entry !== "object") {
    outcome = "absent";
  } else if (entry.source && entry.source.source === "git" && entry.source.url === url && !entry.source.ref) {
    outcome = "current";
  } else {
    entry.source = { source: "git", url };
    write(settingsPath, settings);
    outcome = "updated";
  }
} catch {
  outcome = "unknown";
}
console.log(outcome);
`;

/**
 * The closing note on model selection, printed with the final next steps.
 * It reads the saved registry locally, names the saved model, and flags a
 * `COPILOT_MODEL` still set in the shell: Copilot CLI refuses to start a
 * providers.json model while that variable is set (see
 * COPILOT_LEGACY_MODEL_EXPORT_PATTERN). The former "optional" environment
 * exports are gone: providers.json takes precedence over them, and the
 * COPILOT_MODEL line they included caused exactly that refusal.
 */
export const COPILOT_PROVIDER_INSTRUCTIONS_NODE = String.raw`const fs = require("node:fs");
const path = require("node:path");
const home = process.env.COPILOT_HOME || path.join(require("node:os").homedir(), ".copilot");
const registryPath = process.env.COPILOT_PROVIDERS_CONFIG?.trim() || path.join(home, "providers.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
const state = JSON.parse(fs.readFileSync(registryPath + ".archestra-state.json", "utf8"));
const existing = registry.providers?.find(provider => provider.name === "archestra");
if (!existing || !state.installedModel) throw new Error("Copilot provider configuration was not installed");
const paint = (code, text) => process.stdout.isTTY && !process.env.NO_COLOR
  ? "\x1b[" + code + "m" + text + "\x1b[0m" : text;
const divider = "─".repeat(Math.min(56, process.stdout.columns || 56));
const windows = process.platform === "win32" || process.env.ARCHESTRA_COPILOT_SHELL === "powershell";
const fish = /(?:^|\/)fish$/.test(process.env.SHELL || "");
console.log("\n" + paint("2", divider));
console.log(paint("1;35", "Model selection"));
console.log();
console.log("  Copilot starts with " + paint("1", state.installedModel) + ", saved in settings.json. Switch with /model.");
if (existing.apiKey) {
  console.log("  Your provider settings and API key are saved in:");
} else {
  console.log("  Your provider settings are saved in:");
}
console.log("    " + paint("2", registryPath));
if (!existing.apiKey) console.log("\n  " + paint("1;33", "Add your API key to that file before launching Copilot."));
console.log();
console.log("  Leave COPILOT_MODEL and COPILOT_PROVIDER_* unset: Copilot CLI uses them instead of");
console.log("  providers.json, and with only COPILOT_MODEL set it refuses to start the saved model");
console.log("  (Copilot CLI 1.0.105). The launch check drops them while the LLM proxy is connected.");
const legacy = ${JSON.stringify([...COPILOT_LEGACY_PROVIDER_ENV_VARS])}.filter(name => process.env[name]);
if (legacy.length) {
  console.log();
  console.log("  " + paint("1;33", "Set in this shell: " + legacy.join(", ") + (legacy.length === 1 ? ". To remove it:" : ". To remove them:")));
  if (windows) {
    console.log("    Remove-Item " + legacy.map(name => "Env:" + name).join(", "));
    for (const name of legacy) console.log("    [Environment]::SetEnvironmentVariable('" + name + "', $null, 'User')");
  } else if (fish) {
    console.log("    set -e " + legacy.join(" ") + "    # and delete their lines from ~/.config/fish/config.fish");
  } else {
    console.log("    unset " + legacy.join(" ") + "    # and delete their export lines from ~/.zshrc or ~/.bashrc");
  }
}
console.log(paint("2", divider));
`;
