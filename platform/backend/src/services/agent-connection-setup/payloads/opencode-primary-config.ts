import type { ModelInputModality } from "@archestra/shared/chat";
import { VIRTUAL_KEY_HEADER } from "@archestra/shared/consts";
import {
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
  type SupportedProvider,
} from "@archestra/shared/model-constants";
import {
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  type OpenCodeProviderRoute,
  openCodePassthroughBaseUrl,
} from "@archestra/shared/opencode-provider-routes";
import type { OpenCodeFamilyClient } from "../opencode-family";
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
            ...openCodeModelCapabilities(model.inputModalities),
          })),
        },
      ];
    }),
  );
  // Lets the script and the plugin carry a pinned native model over to its
  // Archestra twin instead of dropping the pin. Twins follow the catalog, not
  // only the passthrough route list.
  const nativeProviders = openCodeProviderTwins(providers);
  // The user's own sign-ins route through the proxy too, with their own
  // credential; the passthrough key attributes those requests to the user.
  const passthroughRoutes = OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.filter(
    (route) => proxy.passthroughProviders?.includes(route.provider),
  );
  const routeHeaders: Record<string, Record<string, string>> = {};
  for (const route of passthroughRoutes) {
    routes[route.openCodeProviderId] = openCodePassthroughBaseUrl(
      proxy.baseUrl,
      route,
    );
    if (proxy.passthroughVirtualKey) {
      routeHeaders[route.openCodeProviderId] = {
        [VIRTUAL_KEY_HEADER]: proxy.passthroughVirtualKey,
      };
    }
  }
  const nativeRoutes = passthroughRoutes.map(
    (route) => route.openCodeProviderId,
  );
  return {
    routes,
    routeHeaders,
    providers,
    nativeProviders,
    nativeRoutes,
    appName,
  };
}

export interface ManagedRuntimeCatalog {
  providers: Record<
    string,
    {
      name: string;
      npm: "@ai-sdk/openai" | "@ai-sdk/openai-compatible";
      options: { baseURL: string };
      models: Record<
        string,
        {
          name: string;
          id: string;
          limit?: { context: number; output: number };
        } & OpenCodeModelCapabilities
      >;
    }
  >;
  routes: Record<string, string>;
  twins: Record<string, string>;
}

/**
 * Credential-free catalog for a managed runtime artifact. Routes are ordinary
 * proxy URLs for the installation's selected agent, never a setup-context path
 * and never the deployment default.
 */
export function publicManagedCatalog(params: {
  primaryProviders?: SetupScriptProxySection["primaryProviders"];
  passthroughProviders?: SupportedProvider[];
  ordinaryBaseUrl: string;
  routingAgentId: string;
}): ManagedRuntimeCatalog {
  const base = params.ordinaryBaseUrl.replace(/\/$/, "");
  const agentId = params.routingAgentId;
  const routes: Record<string, string> = {};
  const providers = Object.fromEntries(
    (params.primaryProviders ?? []).map((entry) => {
      const id = `archestra-${entry.provider}`;
      const routed = (
        MODEL_ROUTER_SUPPORTED_PROVIDERS as readonly SupportedProvider[]
      ).includes(entry.provider);
      const baseURL = `${base}/${routed ? "model-router" : entry.provider}/${agentId}`;
      routes[id] = baseURL;
      return [
        id,
        {
          name: entry.name,
          npm: routed
            ? ("@ai-sdk/openai" as const)
            : ("@ai-sdk/openai-compatible" as const),
          options: { baseURL },
          models: Object.fromEntries(
            entry.models.map((model) => {
              const context = positiveLimit(model.context);
              const output = positiveLimit(model.output);
              return [
                model.id,
                {
                  name: model.name,
                  id: routed ? `${entry.provider}:${model.id}` : model.id,
                  ...(context || output ? { limit: { context, output } } : {}),
                  ...openCodeModelCapabilities(model.inputModalities),
                },
              ];
            }),
          ),
        },
      ];
    }),
  );
  for (const route of OPENCODE_PASSTHROUGH_PROVIDER_ROUTES) {
    if (!params.passthroughProviders?.includes(route.provider)) continue;
    routes[route.openCodeProviderId] = openCodePassthroughBaseUrl(base, {
      ...route,
      pathSuffix: `/${agentId}${route.pathSuffix}`,
    });
  }
  return {
    providers,
    routes,
    twins: openCodeProviderTwins(providers),
  };
}

/**
 * Native provider id → the Archestra catalog provider that serves the same
 * models. Catalog providers are independent of native passthrough support;
 * add OpenCode's differing vendor ids and plan aliases on top.
 */
function openCodeProviderTwins(
  providers: Record<string, unknown>,
): Record<string, string> {
  const routes: readonly OpenCodeProviderRoute[] =
    OPENCODE_PASSTHROUGH_PROVIDER_ROUTES;
  return Object.fromEntries([
    ...Object.keys(providers).map(
      (id) => [id.slice("archestra-".length), id] as const,
    ),
    ...routes.flatMap((route) => {
      const twin = `archestra-${route.provider}`;
      if (!(twin in providers)) return [];
      return [route.openCodeProviderId, ...(route.pinAliases ?? [])].map(
        (id) => [id, twin] as const,
      );
    }),
  ]);
}

function positiveLimit(value: number | null | undefined): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

/**
 * What a model reads, in OpenCode V1's model fields; V2 takes
 * `capabilities.input` from `modalities.input`. OpenCode copies these from
 * models.dev only when the config model's id matches a models.dev key, and the
 * catalog's ids never do, so without them V1 treats every model as text-only
 * and replaces each image with an error. Unknown modalities stay unset, so
 * each client applies its own default.
 */
function openCodeModelCapabilities(
  inputModalities: ModelInputModality[] | null | undefined,
): OpenCodeModelCapabilities {
  if (!inputModalities?.length) return {};
  return {
    modalities: { input: [...inputModalities], output: ["text"] },
    attachment: inputModalities.some((modality) => modality !== "text"),
  };
}

type OpenCodeModelCapabilities = {
  modalities?: { input: ModelInputModality[]; output: ["text"] };
  attachment?: boolean;
};

/** Runs in Node on both platforms; restores only the fields this mode owns. */
export const openCodePrimaryConfigScript = (client: OpenCodeFamilyClient) =>
  String.raw`
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const configPath = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), ${JSON.stringify(client.dir)}, ${JSON.stringify(client.configFile)});
const statePath = path.join(home, ".archestra", ${JSON.stringify(`${client.stateName}-primary-state.json`)});
const keyPath = path.join(home, ".archestra", ${JSON.stringify(`${client.stateName}-primary.key`)});
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
  for (const [name, previous] of Object.entries(state.agents ?? {})) {
    config.agent ??= {};
    config.agent[name] = { ...(config.agent[name] ?? {}), model: previous };
  }
}
if (input) {
  // A previous single-provider setup owns native provider overrides. Restore
  // its original values before taking this mode's snapshot.
  const legacyStatePath = path.join(home, ".archestra", ${JSON.stringify(`${client.stateName}-connection-state.json`)});
  if (fs.existsSync(legacyStatePath)) {
    const legacy = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
    config.provider ??= {};
    for (const [id, previous] of Object.entries(legacy.providerState || {})) {
      if (previous === null) delete config.provider[id]; else config.provider[id] = previous;
      fs.rmSync(path.join(home, ".archestra", ${JSON.stringify(`${client.stateName}-`)} + id + ".key"), { force: true });
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
  // Never add a pin. Keep one that is already served here or on a native
  // provider the user signs in to, move a native one to the catalog provider
  // with the same model id, and drop the rest so OpenCode falls back to the
  // first provider below instead of an account it cannot use.
  const notices = [];
  const nativeRoutes = Array.isArray(input.nativeRoutes) ? input.nativeRoutes : [];
  // The pin to keep: unchanged when served here or on a native route, moved
  // to the catalog twin that serves the same model, or null when nothing
  // here serves it.
  const remap = (pin, label, removed) => {
    const slash = pin.indexOf("/");
    const providerId = pin.slice(0, slash), modelId = pin.slice(slash + 1);
    if (slash > 0 && (inCatalog(providerId, modelId) || nativeRoutes.includes(providerId))) return pin;
    const twin = slash > 0 ? input.nativeProviders?.[providerId] : undefined;
    if (twin && inCatalog(twin, modelId)) {
      const moved = twin + "/" + modelId;
      notices.push(${JSON.stringify(`info:${client.label} `)} + label + " " + pin + " now uses " + moved + " from " + input.appName + ". Disconnect restores " + pin + ".");
      return moved;
    }
    notices.push("warn:" + input.appName + ${JSON.stringify(` does not offer ${client.label} `)} + label + " " + pin + ", so setup removed it. " + removed + " Disconnect restores " + pin + ".");
    return null;
  };
  for (const field of ["model", "small_model"]) {
    const pin = config[field];
    if (typeof pin !== "string") continue;
    const kept = remap(pin, field, ${JSON.stringify(`Choose a model in ${client.label} with /models.`)});
    if (kept === null) delete config[field]; else config[field] = kept;
  }
  // An agent pinned to a model nothing here serves would fail its turn with
  // "Model not found" (Kilo Code pins its compaction agent to a plan model).
  // Only the pins setup changes are snapshotted; disconnect puts them back.
  state.agents = {};
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    if (!agent || typeof agent !== "object" || typeof agent.model !== "string") continue;
    const kept = remap(agent.model, "agent." + name + ".model", "The agent uses the session's model.");
    if (kept === agent.model) continue;
    state.agents[name] = agent.model;
    if (kept === null) delete agent.model; else agent.model = kept;
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
      // Without its modalities the client treats a model as text-only and drops attached images.
      const capabilities = !model.modalities ? {} : v2 ? { capabilities: { input: model.modalities.input } }
        : { modalities: model.modalities, attachment: model.attachment };
      return [model.id, { name: model.name, [v2 ? "modelID" : "id"]: model.wireId,
        ...(context || output ? { limit: { context, output } } : {}), ...capabilities }];
    }));
    const settings = { baseURL: provider.baseURL, apiKey: ${JSON.stringify(`{file:~/.archestra/${client.stateName}-primary.key}`)} };
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
