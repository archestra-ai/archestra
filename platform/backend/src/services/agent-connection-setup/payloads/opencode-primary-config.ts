import {
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
  type SupportedProvider,
} from "@archestra/shared/model-constants";
import { OPENCODE_PASSTHROUGH_PROVIDER_ROUTES } from "@archestra/shared/opencode-provider-routes";
import type { SetupScriptProxySection } from "../types";

/** Custom providers keep the platform's catalog separate from local accounts. */
export function openCodePrimaryConfig(
  proxy: SetupScriptProxySection,
  appName: string,
) {
  const routes: Record<string, string> = {};
  const providers = Object.fromEntries(
    (proxy.primaryProviders ?? []).map((entry) => {
      const id = `archestra-${entry.provider}`;
      const routed = (
        MODEL_ROUTER_SUPPORTED_PROVIDERS as readonly SupportedProvider[]
      ).includes(entry.provider);
      const baseURL = `${proxy.baseUrl}/${routed ? "model-router" : entry.provider}`;
      routes[id] = baseURL;
      return [
        id,
        {
          name: entry.name,
          responses: routed,
          baseURL,
          models: entry.models.map((model) => ({
            ...model,
            wireId: routed ? `${entry.provider}:${model.id}` : model.id,
          })),
        },
      ];
    }),
  );
  // Lets the script carry a pinned native model (openai/x) over to its
  // Archestra twin (archestra-openai/x) instead of dropping the pin.
  const nativeProviders = Object.fromEntries(
    OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map(
      (route) =>
        [route.openCodeProviderId, `archestra-${route.provider}`] as const,
    ).filter(([, id]) => id in providers),
  );
  return { routes, providers, nativeProviders, appName };
}

/** Runs in Node on both platforms; restores only the fields this mode owns. */
export const OPENCODE_PRIMARY_CONFIG_SCRIPT = String.raw`
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const configPath = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode", "opencode.json");
const statePath = path.join(home, ".archestra", "opencode-primary-state.json");
const keyPath = path.join(home, ".archestra", "opencode-primary.key");
const input = JSON.parse(process.env.ARCHESTRA_OC_PRIMARY === "stdin" ? fs.readFileSync(0, "utf8") : process.env.ARCHESTRA_OC_PRIMARY || "null");
if (!input && !fs.existsSync(statePath)) process.exit(0);
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  for (const [section, entries] of Object.entries(state.sections)) {
    config[section] ??= {};
    for (const [id, previous] of Object.entries(entries)) {
      if (previous === null) delete config[section][id]; else config[section][id] = previous;
    }
    if (!Object.keys(config[section]).length) delete config[section];
  }
  for (const [field, previous] of Object.entries(state.fields)) {
    if (previous === null) delete config[field]; else config[field] = previous;
  }
}
if (input) {
  // A previous single-provider setup owns native provider overrides. Restore
  // its original values before taking this mode's snapshot.
  const legacyStatePath = path.join(home, ".archestra", "opencode-connection-state.json");
  if (fs.existsSync(legacyStatePath)) {
    const legacy = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
    config.provider ??= {};
    for (const [id, previous] of Object.entries(legacy.providerState || {})) {
      if (previous === null) delete config.provider[id]; else config.provider[id] = previous;
      fs.rmSync(path.join(home, ".archestra", "opencode-" + id + ".key"), { force: true });
    }
    if (!Object.keys(config.provider).length) delete config.provider;
    if (legacy.enabledProvidersPresent) config.enabled_providers = legacy.enabledProviders;
    else delete config.enabled_providers;
    if (legacy.disabledProvidersPresent) config.disabled_providers = legacy.disabledProviders;
    else delete config.disabled_providers;
    fs.rmSync(legacyStatePath, { force: true });
  }
  const v2 = Number(process.env.ARCHESTRA_OC_MAJOR) >= 2;
  const section = v2 ? "providers" : "provider";
  const state = { sections: { [section]: {} }, fields: {} };
  config[section] ??= {};
  for (const field of ["enabled_providers", "disabled_providers", "model", "small_model"]) {
    state.fields[field] = config[field] ?? null;
  }
  const ids = Object.keys(input.providers);
  const inCatalog = (providerId, modelId) => Boolean(input.providers[providerId]?.models.some(model => model.id === modelId));
  // Never add a pin. Keep one that is already served here, carry a native one
  // over to its Archestra twin (exact model id), and drop the rest so OpenCode
  // falls back to the first provider below instead of an account it cannot use.
  const notices = [];
  for (const field of ["model", "small_model"]) {
    const pin = config[field];
    if (typeof pin !== "string") continue;
    const slash = pin.indexOf("/");
    const providerId = pin.slice(0, slash), modelId = pin.slice(slash + 1);
    if (slash > 0 && inCatalog(providerId, modelId)) continue;
    const twin = slash > 0 ? input.nativeProviders?.[providerId] : undefined;
    if (twin && inCatalog(twin, modelId)) {
      config[field] = twin + "/" + modelId;
      notices.push("info:OpenCode " + field + " " + pin + " now uses " + config[field] + " from " + input.appName + ". Disconnect restores " + pin + ".");
    } else {
      delete config[field];
      notices.push("warn:" + input.appName + " does not offer OpenCode " + field + " " + pin + ", so setup removed it. Choose a model in OpenCode with /models. Disconnect restores " + pin + ".");
    }
  }
  config.enabled_providers = ids;
  if (Array.isArray(config.disabled_providers)) config.disabled_providers = config.disabled_providers.filter(id => !ids.includes(id));
  for (const [id, provider] of Object.entries(input.providers)) {
    state.sections[section][id] = config[section][id] ?? null;
    // Re-insert so OpenCode sees the providers in catalog order on every run.
    delete config[section][id];
    const models = Object.fromEntries(provider.models.map(model => {
      // OpenCode requires both limit fields once limit is set; 0 is its value for unknown.
      const context = model.context > 0 ? model.context : 0, output = model.output > 0 ? model.output : 0;
      return [model.id, { name: model.name, [v2 ? "modelID" : "id"]: model.wireId,
        ...(context || output ? { limit: { context, output } } : {}) }];
    }));
    const settings = { baseURL: provider.baseURL, apiKey: "{file:~/.archestra/opencode-primary.key}" };
    config[section][id] = v2
      ? { name: provider.name, package: provider.responses ? "@opencode/ai/providers/openai-compatible/responses" : "@opencode/ai/providers/openai-compatible", settings, models }
      : { name: provider.name, npm: provider.responses ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible", options: settings, models };
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  fs.writeFileSync(keyPath, process.env.ARCHESTRA_OC_KEY, { mode: 0o600 });
  for (const notice of notices) console.log(notice);
} else {
  fs.rmSync(statePath, { force: true });
  fs.rmSync(keyPath, { force: true });
}
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
`;
