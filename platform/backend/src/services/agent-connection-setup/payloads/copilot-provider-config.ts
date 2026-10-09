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
function read(file, jsonc = false) {
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
}
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
    headers: input.headers };
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
  if (key) console.log("Your API key is installed in providers.json. Environment variables are optional.");
  else console.log("No API key was available. Add your provider key as apiKey in providers.json before launching Copilot.");
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

/** Read saved credentials locally when the final next steps are printed. */
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
console.log("\n" + paint("2", divider));
console.log(paint("1;35", "Environment variables (optional)"));
console.log();
if (existing.apiKey) {
  console.log("  Your provider settings and API key are already saved in:");
} else {
  console.log("  Your provider settings are saved in:");
}
console.log("    " + paint("2", registryPath));
if (!existing.apiKey) console.log("\n  " + paint("1;33", "Add your API key to that file before launching Copilot."));
if (process.env.COPILOT_MODEL && process.env.COPILOT_MODEL !== state.installedModel && process.env.COPILOT_MODEL !== state.installedModel.slice("archestra/".length)) {
  console.log("\n  " + paint("1;33", "Your existing COPILOT_MODEL selects another model."));
  console.log("  Unset COPILOT_MODEL to use the saved model.");
}
const values = {
  COPILOT_PROVIDER_TYPE: existing.type,
  COPILOT_PROVIDER_BASE_URL: existing.baseUrl,
  COPILOT_PROVIDER_API_KEY: existing.apiKey || "<your-provider-api-key>",
  COPILOT_MODEL: state.installedModel,
  COPILOT_PROVIDER_HEADERS: Object.entries(existing.headers || {}).map(([key, value]) => key + ": " + value).join("\\n"),
};
const fish = /(?:^|\/)fish$/.test(process.env.SHELL || "");
const windows = process.platform === "win32" || process.env.ARCHESTRA_COPILOT_SHELL === "powershell";
console.log();
console.log(windows
  ? "  You may also set these environment variables in PowerShell:"
  : "  You may also add these environment variables to your shell profile");
if (!windows) {
  console.log("  (" + paint("1", fish ? "~/.config/fish/config.fish" : "~/.zshrc or ~/.bashrc") + "):");
}
console.log();
for (const [name, value] of Object.entries(values)) {
  const quoted = windows ? "'" + value.replace(/'/g, "''") + "'" : fish
    ? "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"
    : "'" + value.replace(/'/g, "'\\''") + "'";
  const variable = paint("1;36", name);
  console.log("  " + (windows ? "$env:" + variable + " = " + quoted : fish ? "set -gx " + variable + " " + quoted : "export " + variable + "=" + quoted));
  console.log();
}
console.log(paint("2", divider));
`;
