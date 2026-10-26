import { VIRTUAL_KEY_HEADER } from "@archestra/shared/consts";
import type { SupportedProvider } from "@archestra/shared/model-constants";
import {
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  type OpenCodeProviderRoute,
  openCodePassthroughBaseUrl,
} from "@archestra/shared/opencode-provider-routes";
import type { OpenCodeFamilyClient } from "../opencode-family";
import type { SetupScriptProxySection } from "../types";

/**
 * What the connection serves in an OpenCode-family client, keyed by the
 * client's own provider ids (models.dev). The routing plugin filters the
 * client's stock catalog to these providers and models and sends their
 * requests to the proxy. The client shows no Archestra-specific provider and
 * no renamed one; the mapping between its ids and the proxy's stays inside the
 * plugin.
 */
export interface ManagedRuntimeCatalog {
  /** Stock provider id → proxy base URL for that provider's native wire. */
  routes: Record<string, string>;
  /**
   * Stock provider id → the model ids the organization's credential serves
   * there, in catalog order. Absent for a provider only the user's own
   * sign-in can serve.
   */
  managed: Record<string, string[]>;
  /**
   * Stock provider ids the user may sign in to from the client. Their own
   * credential goes through the proxy with the passthrough key.
   */
  passthrough: string[];
  /**
   * `archestra-<provider>` ids that earlier setups wrote into the client's
   * config → the stock id that now serves the same models, so a pin on one
   * keeps working.
   */
  legacy: Record<string, string>;
}

type PrimaryProviders = NonNullable<
  SetupScriptProxySection["primaryProviders"]
>;

/**
 * The catalog over the client's stock providers. A primary provider without a
 * row in the route table has no stock provider in the client, so it cannot be
 * shown; `unsupported` names those keys for the installer's notice.
 */
function openCodeCatalog(params: {
  primaryProviders?: PrimaryProviders;
  passthroughProviders?: SupportedProvider[];
  routeUrl: (route: OpenCodeProviderRoute) => string;
}): { catalog: ManagedRuntimeCatalog; unsupported: string[] } {
  const catalog: ManagedRuntimeCatalog = {
    routes: {},
    managed: {},
    passthrough: [],
    legacy: {},
  };
  const shown = new Set<SupportedProvider>();
  for (const route of OPENCODE_PASSTHROUGH_PROVIDER_ROUTES) {
    const id = route.openCodeProviderId;
    const entry = params.primaryProviders?.find(
      (candidate) => candidate.provider === route.provider,
    );
    const passthrough =
      params.passthroughProviders?.includes(route.provider) ?? false;
    if (!entry && !passthrough) continue;
    catalog.routes[id] = params.routeUrl(route);
    if (entry) {
      shown.add(entry.provider);
      catalog.managed[id] = entry.models.map((model) => model.id);
      catalog.legacy[`archestra-${route.provider}`] = id;
    }
    if (passthrough) catalog.passthrough.push(id);
  }
  const unsupported = (params.primaryProviders ?? [])
    .filter((entry) => !shown.has(entry.provider))
    .map((entry) => entry.name);
  return { catalog, unsupported };
}

/**
 * Setup-time catalog and routes under the setup context's base URL. The
 * routing plugin applies them while connected; the installer writes no
 * provider into the client's config.
 */
export function openCodePrimaryConfig(
  proxy: SetupScriptProxySection,
  appName: string,
) {
  const { catalog, unsupported } = openCodeCatalog({
    primaryProviders: proxy.primaryProviders,
    passthroughProviders: proxy.passthroughProviders,
    routeUrl: (route) => openCodePassthroughBaseUrl(proxy.baseUrl, route),
  });
  // The passthrough key attributes the user's own sign-ins to the user. It
  // never goes on a request the connection's own key authenticates.
  const routeHeaders: Record<string, Record<string, string>> = {};
  if (proxy.passthroughVirtualKey) {
    for (const id of catalog.passthrough) {
      routeHeaders[id] = { [VIRTUAL_KEY_HEADER]: proxy.passthroughVirtualKey };
    }
  }
  return {
    routes: catalog.routes,
    routeHeaders,
    catalog,
    unsupported,
    appName,
  };
}

/**
 * Credential-free catalog for a managed runtime artifact. Routes are ordinary
 * proxy URLs for the installation's selected agent, never a setup-context path
 * and never the deployment default.
 */
export function publicManagedCatalog(params: {
  primaryProviders?: PrimaryProviders;
  passthroughProviders?: SupportedProvider[];
  ordinaryBaseUrl: string;
  routingAgentId: string;
}): ManagedRuntimeCatalog {
  const base = params.ordinaryBaseUrl.replace(/\/$/, "");
  return openCodeCatalog({
    primaryProviders: params.primaryProviders,
    passthroughProviders: params.passthroughProviders,
    routeUrl: (route) =>
      openCodePassthroughBaseUrl(base, {
        ...route,
        pathSuffix: `/${params.routingAgentId}${route.pathSuffix}`,
      }),
  }).catalog;
}

/**
 * Runs in Node on both platforms. Connect leaves the client's providers,
 * allowlists and pins alone: the routing plugin filters the client's own
 * catalog while connected, so there is nothing to restore later. The state
 * file marks the connection, and disconnect still restores what an older
 * installer changed.
 */
export const openCodePrimaryConfigScript = (client: OpenCodeFamilyClient) =>
  String.raw`
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const configPath = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), ${JSON.stringify(client.dir)}, ${JSON.stringify(client.configFile)});
const statePath = path.join(home, ".archestra", ${JSON.stringify(`${client.stateName}-primary-state.json`)});
const keyPath = path.join(home, ".archestra", ${JSON.stringify(`${client.stateName}-primary.key`)});
const input = JSON.parse(process.env.ARCHESTRA_OC_PRIMARY === "stdin" ? fs.readFileSync(0, "utf8") : process.env.ARCHESTRA_OC_PRIMARY || "null");
if (!input && !fs.existsSync(statePath)) process.exit(0);
const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
const config = original ? JSON.parse(original.replace(/^\uFEFF/, "")) : {};
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  for (const [section, entries] of Object.entries(state.sections ?? {})) {
    config[section] ??= {};
    for (const [id, previous] of Object.entries(entries)) {
      if (previous === null) delete config[section][id]; else config[section][id] = previous;
    }
    if (!Object.keys(config[section]).length) delete config[section];
  }
  for (const [field, previous] of Object.entries(state.fields ?? {})) {
    if (previous === null) delete config[field]; else config[field] = previous;
  }
  for (const [name, previous] of Object.entries(state.agents ?? {})) {
    config.agent ??= {};
    config.agent[name] = { ...(config.agent[name] ?? {}), model: previous };
  }
}
if (input) {
  // A previous single-provider setup owns native provider overrides. Restore
  // its original values before this connection takes over.
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
  // A pin the connection cannot serve is left in place and ignored while
  // connected; the plugin drops it in memory and the client falls back to
  // its first provider. Say so once, here.
  const routes = input.routes ?? {};
  const managed = input.catalog?.managed ?? {};
  const passthrough = Array.isArray(input.catalog?.passthrough) ? input.catalog.passthrough : [];
  const legacy = input.catalog?.legacy ?? {};
  // The same test the plugin applies at load: a pin on an id an earlier
  // setup wrote moves to the client's own provider.
  const served = (pin) => {
    const slash = pin.indexOf("/");
    if (slash <= 0) return false;
    const pinned = pin.slice(0, slash), modelId = pin.slice(slash + 1);
    const providerId = Object.hasOwn(legacy, pinned) ? legacy[pinned] : pinned;
    if (!routes[providerId]) return false;
    return passthrough.includes(providerId) || (managed[providerId] ?? []).includes(modelId);
  };
  const notices = [];
  for (const field of ["model", "small_model"]) {
    const pin = config[field];
    if (typeof pin !== "string" || served(pin)) continue;
    notices.push("warn:" + input.appName + ${JSON.stringify(` does not offer ${client.label} `)} + field + " " + pin + ${JSON.stringify(`. ${client.label} ignores it while connected. Choose a model in ${client.label} with /models.`)});
  }
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    if (!agent || typeof agent !== "object" || typeof agent.model !== "string" || served(agent.model)) continue;
    notices.push("warn:" + input.appName + ${JSON.stringify(` does not offer ${client.label} agent.`)} + name + ".model " + agent.model + ". The agent uses the session's model while connected.");
  }
  for (const name of input.unsupported ?? []) {
    notices.push("warn:" + name + ${JSON.stringify(` has no ${client.label} provider, so ${client.label} does not list its models.`)});
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ sections: {}, fields: {}, agents: {} }), { mode: 0o600 });
  fs.writeFileSync(keyPath, process.env.ARCHESTRA_OC_KEY, { mode: 0o600 });
  for (const notice of notices) console.log(notice);
} else {
  fs.rmSync(statePath, { force: true });
  fs.rmSync(keyPath, { force: true });
}
const updated = JSON.stringify(config, null, 2) + "\n";
if (original !== null ? original !== updated : Object.keys(config).length > 0) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, updated);
}
`;
