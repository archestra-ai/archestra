import { DEFAULT_APP_NAME, OPENCODE_AGENT_HEADER } from "@archestra/shared";
import { VIRTUAL_KEY_HEADER } from "@archestra/shared/consts";
import { OPENCODE_CLIENT, type OpenCodeFamilyClient } from "../opencode-family";
import type { ManagedRuntimeCatalog } from "./opencode-primary-config";

// white-label-ok: stable OpenCode V1 plugin export, not display copy
export const OPENCODE_V1_PROXY_EXPORT = "ArchestraLlmProxy";
// white-label-ok: stable OpenCode V1 OAuth plugin export, not display copy
export const OPENCODE_V1_OAUTH_EXPORT = "ArchestraOpenAiOAuth";

interface RenderOpenCodeRoutingPluginParams {
  /** Managed implementations read credentials from the private installation file. */
  runtime?: boolean;
  /** Deployment name for user-facing errors. Runtime copies read it from params. */
  appName?: string;
  /**
   * What the connection serves, over the client's own providers. Credentials
   * stay in the local key file.
   */
  catalog?: ManagedRuntimeCatalog;
  routes: Record<string, string>;
  headers: Record<string, string>;
  /**
   * Extra headers for one route only, keyed by provider id: the passthrough
   * key goes on providers that sign in with the user's own credential, never
   * on a provider that already authenticates with a virtual key.
   */
  routeHeaders?: Record<string, Record<string, string>>;
  /** The client the plugin runs in; OpenCode when omitted. */
  client?: OpenCodeFamilyClient;
}

/**
 * Renders the global OpenCode plugin that configures and validates managed routes.
 *
 * Inject values only with JSON.stringify. The return value is JavaScript source.
 * Unescaped template interpolation can inject code into the generated plugin.
 */
function renderedAppName(params: RenderOpenCodeRoutingPluginParams): string {
  const fallback = JSON.stringify(params.appName ?? DEFAULT_APP_NAME);
  return params.runtime ? `runtimeParams.appName || ${fallback}` : fallback;
}

export function renderOpenCodeRoutingPlugin(
  params: RenderOpenCodeRoutingPluginParams,
): string {
  const { dir, label, stateName } = params.client ?? OPENCODE_CLIENT;
  // The client values go in before the wire-header constant below, so every
  // later line stays covered by its white-label waiver.
  return `import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

${params.runtime ? 'const runtimeParams = JSON.parse(readFileSync(new URL("../params.json", import.meta.url), "utf8"));' : ""}
${catalogSource(params)}
const installedRoutes = ${params.runtime ? "runtimeParams.routes ?? {}" : JSON.stringify(params.routes)};
const routes = hasCatalog ? { ...catalogRoutes } : { ...installedRoutes };
let activeRoutes = { ...routes };
const managedHeaders = ${params.runtime ? "{ ...runtimeParams.headers }" : JSON.stringify(params.headers)};
${params.runtime ? RUNTIME_ROUTE_HEADERS : `const routeHeaders = ${JSON.stringify(params.routeHeaders ?? {})};`}
let effectiveRouteHeaders = { ...routeHeaders };
// Providers the organization's credential serves in the current config pass,
// with the key they carry and the models that credential serves on each.
const managedKeys = new Map();
const managedModels = new Map();
const managedKeyFile = ${params.runtime ? "runtimeParams.managedKeyPath ?? " : ""}join(homedir(), ".archestra", ${JSON.stringify(`${stateName}-primary.key`)});
const readManagedKey = () => {
  try { const value = readFileSync(managedKeyFile, "utf8").trim(); if (value) return value; } catch {}
  return ${params.runtime ? 'typeof runtimeParams.managedKey === "string" ? runtimeParams.managedKey.trim() : ""' : '""'};
};
${
  params.runtime
    ? `const sessionProofSymbol = Symbol.for("archestra." + runtimeParams.clientId + ".sessionBindingProofs");
const sessionBindingProofs = globalThis[sessionProofSymbol] ?? (globalThis[sessionProofSymbol] = new Map());
const mcpConnected = () => {
  try { return !readFileSync(join(homedir(), runtimeParams.skipRelpath), "utf8").split(/\\r?\\n/).includes("mcp"); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
};
export function bindSessionProof(sessionID, proof) {
  if (typeof sessionID !== "string" || sessionID.length > 512) return;
  sessionBindingProofs.delete(sessionID);
  sessionBindingProofs.set(sessionID, { origin: runtimeParams.origin, headers: proof ?? {} });
  if (sessionBindingProofs.size > 512) sessionBindingProofs.delete(sessionBindingProofs.keys().next().value);
}`
    : ""
}
${
  params.runtime
    ? `export function captureMcpAliases(config) {
  const matches = Object.entries(config.mcp ?? {}).filter(([, entry]) => entry?.type === "remote" && entry.url === runtimeParams.mcp?.url);
  const active = matches.filter(([, entry]) => entry.enabled !== false);
  active.sort(([a], [b]) => a === runtimeParams.mcp?.serverName ? -1 : b === runtimeParams.mcp?.serverName ? 1 : 0);
  const aliases = [...active, ...matches.filter(([, entry]) => entry.enabled === false)].map(([name]) => name);
  const aliasesJson = JSON.stringify(aliases).split("").map(char => char.charCodeAt(0) > 127 ? "\\\\u" + char.charCodeAt(0).toString(16).padStart(4, "0") : char).join("");
  if (active.length && aliases.length <= 64 && aliasesJson.length <= 8192 && runtimeParams.source?.token) {
    return { "x-archestra-client-runtime-token": runtimeParams.source.token, "x-archestra-mcp-aliases": aliasesJson };
  } else {
    return {};
  }
}`
    : ""
}
const headersFor = (providerId) => ({ ...managedHeaders, ...(effectiveRouteHeaders[providerId] ?? {}) });
const credentialEnvByProvider = ${JSON.stringify(OPENCODE_CREDENTIAL_ENV_BY_PROVIDER)};
const normalizeUrl = (value) => String(value ?? "").replace(/\\/+$/, "");

const directInferencePath = /(?:\\/(?:messages|responses|chat\\/completions)|\\/v1beta\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)|\\/backend-api\\/codex\\/responses)$/;
const fetchGuardSymbol = Symbol.for("archestra.opencode.llmProxyFetchGuard");
const openAiOAuthBridgeHeader = "x-archestra-opencode-oauth-bridge";
// Names the managed alias that sent a request. The fetch guard removes it
// before the request leaves the client.
const managedAliasHeader = "x-archestra-managed-alias";
// A managed route takes only the managed key, so every credential the client
// set goes before it is added.
const clientCredentialHeaders = ["Authorization", "ChatGPT-Account-Id", "x-goog-api-key", "x-api-key", openAiOAuthBridgeHeader];
const openAiApiBaseUrl = "https://api.openai.com/v1";
const clientLabel = ${JSON.stringify(label)};
const clientDir = ${JSON.stringify(dir)};
const appName = ${renderedAppName(params)};
// white-label-ok: This constant is a stable wire header identifier.
const openCodeAgentHeader = ${JSON.stringify(OPENCODE_AGENT_HEADER)};
const chatGptResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";

const authPath = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), clientDir, "auth.json");
// Read again on every use: the user can sign in to a provider from the client
// after this plugin loaded.
const readLocalAuth = () => {
  try { return JSON.parse(readFileSync(authPath, "utf8")); } catch { return {}; }
};
const localAuth = readLocalAuth();
const openAiOAuth = localAuth.openai?.type === "oauth" ? localAuth.openai : null;
const googleOAuth = localAuth.google?.type === "oauth" ? localAuth.google : null;
const currentOpenAiOAuth = () => {
  const auth = readLocalAuth().openai;
  return auth?.type === "oauth" ? auth : null;
};
const usableAuth = (localAuth, providerId) => {
  const auth = localAuth[providerId];
  if (auth?.type === "api") return typeof auth.key === "string" && auth.key.trim() !== "";
  if (auth?.type !== "oauth") return false;
  return (typeof auth.access === "string" && auth.access.trim() !== "") || (typeof auth.refresh === "string" && auth.refresh.trim() !== "");
};
const usableEnvironment = (providerId) => (credentialEnvByProvider[providerId] ?? [])
  .some((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "");

const directFetchSymbol = Symbol.for("archestra.opencode.directFetch");
const rawDirectFetch = globalThis[directFetchSymbol] ?? (globalThis[directFetchSymbol] = globalThis.fetch.bind(globalThis));
// The client's own sign-in transport for a provider the organization's
// credential serves: the request goes to the managed route with the managed
// key, whatever credential the sign-in put in the headers.
const managedAuth = (id) => ({ apiKey: managedKeys.get(id), baseURL: activeRoutes[id],
  fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const route = activeRoutes[id], key = managedKeys.get(id);
    if (!route || !key || !underRoute(url, route)) throw new Error("Unsupported managed authentication request.");
    return directFetch(new Request(request, { headers: withManagedCredential(request.headers, id, key) }));
  },
});
const underRoute = (url, route) => {
  const base = new URL(route);
  return base.origin === url.origin && url.pathname.startsWith(base.pathname.replace(/\\/+$/, "") + "/");
};
// Every credential the client set goes; the managed key takes its place. The
// SDK's own header for that key (x-api-key, x-goog-api-key) may stay: the
// proxy accepts the key in any of them.
const withManagedCredential = (source, id, key) => {
  const headers = new Headers(source);
  headers.delete(managedAliasHeader);
  for (const name of clientCredentialHeaders) {
    const value = headers.get(name);
    if (value !== null && value !== key && value !== "Bearer " + key) headers.delete(name);
  }
  headers.set("Authorization", "Bearer " + key);
  for (const [name, value] of Object.entries(headersFor(id))) headers.set(name, value);
  return headers;
};
// The client's own sign-in for a managed provider can replace the managed key
// with its own token: Kilo Code does this after an xAI sign-in. The managed
// route accepts only the managed key, so that token never goes there.
const withManagedAliasKey = (request, url, id) => {
  const key = managedKeys.get(id), route = key ? activeRoutes[id] : undefined;
  if (route && underRoute(url, route)) return new Request(request, { headers: withManagedCredential(request.headers, id, key) });
  const headers = new Headers(request.headers);
  headers.delete(managedAliasHeader);
  return new Request(request, { headers });
};
const directFetch = ${
    params.runtime
      ? `(input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("x-archestra-client-runtime-token");
  headers.delete("x-archestra-mcp-aliases");
  const managedRoute = Object.values(activeRoutes).some(route => {
    const base = new URL(route);
    return base.origin === url.origin && url.pathname.startsWith(base.pathname.replace(/\\/+$/, "") + "/");
  });
  if (url.protocol === "https:" && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && url.origin === runtimeParams.origin && managedRoute && directInferencePath.test(url.pathname) && mcpConnected()) {
    const binding = sessionBindingProofs.get(headers.get("x-opencode-session"));
    for (const [name, value] of Object.entries(binding?.origin === url.origin ? binding.headers : {})) headers.set(name, value);
  }
  return rawDirectFetch(new Request(request, { headers, redirect: headers.has("x-archestra-client-runtime-token") ? "error" : request.redirect }));
}`
      : "rawDirectFetch"
  };
const computeProxyOrigins = (routesMap) => new Set(Object.values(routesMap).map((value) => new URL(value).origin));
let proxyOrigins = computeProxyOrigins(activeRoutes);
const onProxyOrigin = (value) => { try { return proxyOrigins.has(new URL(String(value)).origin); } catch { return false; } };

if (${params.runtime ? "true" : "!globalThis[fetchGuardSymbol]"}) {
  globalThis.fetch = (input, init) => {
    let request = new Request(input, init);
    const url = new URL(request.url);
    const alias = request.headers.get(managedAliasHeader);
    if (alias !== null) request = withManagedAliasKey(request, url, alias);
    // A ChatGPT sign-in made after startup still has its requests bridged.
    const chatGptAuth = url.href === chatGptResponsesUrl ? openAiOAuth ?? currentOpenAiOAuth() : null;
    if (chatGptAuth) {
      const target = routes.openai;
      if (!target) throw new Error("OpenAI OAuth is not supported by the connected " + appName + " LLM proxy.");
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(headersFor("openai"))) headers.set(name, value);
      if (!headers.has("Authorization")) throw new Error("OpenAI OAuth request is missing its current bearer token. Refresh the " + clientLabel + " OpenAI connection and try again.");
      if (!headers.has("ChatGPT-Account-Id") && chatGptAuth.accountId) headers.set("ChatGPT-Account-Id", chatGptAuth.accountId);
      headers.set(openAiOAuthBridgeHeader, "true");
      return directFetch(new Request(target + "/responses", { method: request.method, headers, body: request.body, signal: request.signal, duplex: request.body ? "half" : undefined }));
    }
    if (!proxyOrigins.has(url.origin) && directInferencePath.test(url.pathname)) {
      throw new Error(
        'Blocked a direct provider inference request to "' + url.origin + '" while ' + clientLabel + ' is connected to the ' + appName + ' LLM proxy.',
      );
    }
    return directFetch(request);
  };
  globalThis[fetchGuardSymbol] = true;
}

export const ${OPENCODE_V1_PROXY_EXPORT} = async () => ({
  async config(config) {
    config.provider ??= {};
    const localAuth = readLocalAuth();
    const signedInToOpenAi = localAuth.openai?.type === "oauth";
    const managedKey = readManagedKey();
    effectiveRouteHeaders = { ...routeHeaders };
    managedKeys.clear();
    managedModels.clear();
    // An earlier setup wrote the proxy's providers into the client's config
    // under the proxy's own provider ids. The client's own providers serve those models now,
    // so the entries go; rehome below moves a pin on one.
    for (const [id, entry] of Object.entries(config.provider)) {
      if (id.startsWith("archestra-") && onProxyOrigin(entry?.options?.baseURL)) delete config.provider[id];
    }
    const nativeCredential = (providerId) => {
      const key = config.provider[providerId]?.options?.apiKey;
      return usableAuth(localAuth, providerId) || usableEnvironment(providerId) ||
        (typeof key === "string" && key.trim() !== "" && key !== managedKey && !key.startsWith("archestra_"));
    };
    activeRoutes = {};
    for (const [providerId, baseURL] of Object.entries(routes)) {
      // The user's own sign-in comes first where the connection allows it:
      // their account, through the proxy with the passthrough key.
      if ((!hasCatalog || catalogPassthrough.includes(providerId)) && nativeCredential(providerId)) {
        const provider = config.provider[providerId] ?? {};
        provider.options ??= {};
        provider.options.baseURL = providerId === "openai" && signedInToOpenAi ? openAiApiBaseUrl : baseURL;
        provider.options.headers = { ...(provider.options.headers ?? {}), ...headersFor(providerId) };
        config.provider[providerId] = provider;
        activeRoutes[providerId] = baseURL;
        continue;
      }
      const served = catalogManaged[providerId];
      if (served && managedKey) {
        // The organization's credential. The client's provider keeps its name,
        // ids and model data; only the models that credential serves stay,
        // and they go to the proxy with the managed key.
        effectiveRouteHeaders[providerId] = {};
        const previous = config.provider[providerId] ?? {};
        const { apiKey: _replaced, ...options } = previous.options ?? {};
        // A credential the user configured for their own account stays out
        // of the request; the rest of their headers stay.
        const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => !clientCredentialHeaders.some((credential) => credential.toLowerCase() === name.toLowerCase())));
        const whitelist = Array.isArray(previous.whitelist) ? served.filter((id) => previous.whitelist.includes(id)) : [...served];
        config.provider[providerId] = { ...previous, whitelist,
          options: { ...options, baseURL, apiKey: managedKey, headers: { ...headers, ...headersFor(providerId) } },
        };
        managedKeys.set(providerId, managedKey);
        managedModels.set(providerId, whitelist);
        activeRoutes[providerId] = baseURL;
        continue;
      }
      // Listed so the user can sign in from the client, but not configured:
      // an entry alone would load a provider that has no credential yet.
      if (normalizeUrl(config.provider[providerId]?.options?.baseURL) === normalizeUrl(baseURL)) {
        delete config.provider[providerId];
      }
    }
    proxyOrigins = computeProxyOrigins(routes);
    // Only the connection's providers stay in the picker: the ones the user
    // may sign in to, signed in or not, and the ones the organization's key
    // serves while that key is readable.
    const providerIds = Object.keys(routes).filter((id) => !hasCatalog || catalogPassthrough.includes(id) || managedKeys.has(id));
    config.enabled_providers = providerIds;
    if (Array.isArray(config.disabled_providers)) {
      config.disabled_providers = config.disabled_providers.filter((id) => !providerIds.includes(id));
    }
    // A model pinned to a provider or model the connection does not serve
    // would fail its turn with "Model not found": the default model, the
    // small model, and an agent's own model (Kilo Code pins its compaction
    // agent to a Kimi plan model). Such a pin is dropped and the client falls
    // back to the session's model. A pin on the proxy's own provider id from an earlier
    // setup moves to the client's own provider.
    const rehome = (model) => {
      if (typeof model !== "string") return model;
      const slash = model.indexOf("/");
      const pinned = slash > 0 ? model.slice(0, slash) : model;
      const modelId = slash > 0 ? model.slice(slash + 1) : "";
      const providerId = Object.hasOwn(legacyProviderIds, pinned) ? legacyProviderIds[pinned] : pinned;
      if (!Object.hasOwn(activeRoutes, providerId)) return undefined;
      const models = managedModels.get(providerId);
      if (models && !models.includes(modelId)) return undefined;
      return slash > 0 ? providerId + "/" + modelId : providerId;
    };
    for (const field of ["model", "small_model"]) {
      const kept = rehome(config[field]);
      if (kept === undefined) delete config[field]; else config[field] = kept;
    }
    for (const agent of Object.values(config.agent ?? {})) {
      if (!agent || typeof agent !== "object") continue;
      const kept = rehome(agent.model);
      if (kept === undefined) delete agent.model; else agent.model = kept;
    }
  },
  async "chat.params"(input) {
    const providerId = input.provider.id ?? input.provider.info?.id;
    const expected = activeRoutes[providerId];
    if (!expected) {
      throw new Error(
        clientLabel + ' provider "' + providerId + '" is not supported by the connected ' + appName + ' LLM proxy. Disconnect or reconfigure the proxy before using it.',
      );
    }
    const actual = input.provider.options?.baseURL;
    const expectedResolved = providerId === "openai" && currentOpenAiOAuth() ? openAiApiBaseUrl : expected;
    if (normalizeUrl(actual) !== normalizeUrl(expectedResolved)) {
      throw new Error(
        clientLabel + ' provider "' + providerId + '" resolved to "' + (actual ?? 'no base URL') + '" instead of the connected ' + appName + ' endpoint. Re-run the connection setup.',
      );
    }
  },
  async "chat.headers"(input, output) {
    const providerId = input.provider.id ?? input.provider.info?.id;
    if (!activeRoutes[providerId]) return;
    Object.assign(output.headers, headersFor(providerId));
    output.headers["x-opencode-session"] = input.sessionID;
    output.headers[openCodeAgentHeader] = input.agent;
    if (managedKeys.has(providerId)) output.headers[managedAliasHeader] = providerId;
  },
  ...(googleOAuth ? {
    auth: {
      provider: "google",
      methods: [],
      async loader(auth) {
        if (managedKeys.has("google")) return managedAuth("google");
        const credential = await auth();
        if (!credential || credential.type !== "oauth" || !credential.access) return {};
        return {
          apiKey: "archestra-oauth-bridge",
          fetch: async (input, init) => {
            if (credential.expires && credential.expires <= Date.now()) {
              throw new Error("Google OAuth access token expired. Refresh the " + clientLabel + " Google connection and try again.");
            }
            const request = new Request(input, init);
            const headers = new Headers(request.headers);
            headers.delete("x-goog-api-key");
            headers.set("Authorization", "Bearer " + credential.access);
            for (const [name, value] of Object.entries(headersFor("google"))) headers.set(name, value);
            if (process.env.GOOGLE_CLOUD_PROJECT) headers.set("x-goog-user-project", process.env.GOOGLE_CLOUD_PROJECT);
            return directFetch(new Request(request, { headers }));
          },
        };
      },
    },
  } : {}),
});

export const ${OPENCODE_V1_OAUTH_EXPORT} = async () => ({
  ...(openAiOAuth ? {
    auth: {
      provider: "openai",
      methods: [],
      async loader(auth) {
        if (managedKeys.has("openai")) return managedAuth("openai");
        const credential = await auth();
        if (!credential || credential.type !== "oauth" || !credential.access) return {};
        const accountId = credential.accountId ?? openAiOAuth.accountId;
        if (!accountId) throw new Error("OpenAI OAuth account ID is missing. Refresh the " + clientLabel + " OpenAI connection and try again.");
        return {
          apiKey: "archestra-oauth-bridge",
          fetch: async (input, init) => {
            if (credential.expires && credential.expires <= Date.now()) {
              throw new Error("OpenAI OAuth access token expired. Refresh the " + clientLabel + " OpenAI connection and try again.");
            }
            const request = new Request(input, init);
            const headers = new Headers(request.headers);
            headers.set("Authorization", "Bearer " + credential.access);
            headers.set("ChatGPT-Account-Id", accountId);
            headers.set(openAiOAuthBridgeHeader, "true");
            for (const [name, value] of Object.entries(headersFor("openai"))) headers.set(name, value);
            const target = routes.openai;
            if (!target) throw new Error("OpenAI OAuth is not supported by the connected " + appName + " LLM proxy.");
            return directFetch(new Request(target + "/responses", { method: request.method, headers, body: request.body, signal: request.signal, duplex: request.body ? "half" : undefined }));
          },
        };
      },
    },
  } : {}),
});
`;
}

/**
 * OpenCode 2 replaced the V1 plugin API: the loader reads only a default export
 * with an `id` and a `setup(ctx)` function, and V1 hook objects never run. The
 * setup script installs this variant when `opencode --version` reports 2 or
 * later, at the same path, so disconnect restores either one the same way.
 *
 * V2 keeps credentials in its own store and applies its own sign-in transport,
 * so the plugin only has to send every model request to the managed route:
 * - providers without a route are disabled, matching V1's enabled_providers
 *   list; a provider the organization's credential serves keeps its stock
 *   name and ids, lists only the models that credential serves, and carries
 *   the managed key;
 * - the `model.request` hook swaps the base URL and adds the attribution
 *   headers, and fails closed for a provider the proxy cannot route;
 * - a ChatGPT sign-in (OpenAI requests bound for the Codex backend) is marked
 *   with the OAuth bridge header, as V1's fetch bridge did.
 *
 * This variant has no config hook, so a pin on a model the connection does
 * not serve fails closed in `model.request`; the installer warns about such a
 * pin at setup.
 *
 * Inject values only with JSON.stringify. The return value is JavaScript source.
 */
export function renderOpenCodeRoutingPluginV2(
  params: RenderOpenCodeRoutingPluginParams,
): string {
  return `import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
${params.runtime ? 'const runtimeParams = JSON.parse(readFileSync(new URL("../params.json", import.meta.url), "utf8"));\n' : ""}const appName = ${renderedAppName(params)};
${catalogSource(params)}
const installedRoutes = ${params.runtime ? "runtimeParams.routes ?? {}" : JSON.stringify(params.routes)};
const routes = hasCatalog ? { ...catalogRoutes } : { ...installedRoutes };
let activeRoutes = { ...routes };
${params.runtime ? RUNTIME_ROUTE_HEADERS : `const routeHeaders = ${JSON.stringify(params.routeHeaders ?? {})};`}
let effectiveRouteHeaders = { ...routeHeaders };
const managedHeaders = ${params.runtime ? "runtimeParams.headers" : JSON.stringify(params.headers)};
const credentialEnvByProvider = ${JSON.stringify(OPENCODE_CREDENTIAL_ENV_BY_PROVIDER)};
const managedKeyFile = ${params.runtime ? "runtimeParams.managedKeyPath ?? " : ""}join(homedir(), ".archestra", ${JSON.stringify(`${(params.client ?? OPENCODE_CLIENT).stateName}-primary.key`)});
const readManagedKey = () => {
  try { const value = readFileSync(managedKeyFile, "utf8").trim(); if (value) return value; } catch {}
  return ${params.runtime ? 'typeof runtimeParams.managedKey === "string" ? runtimeParams.managedKey.trim() : ""' : '""'};
};
${
  params.runtime
    ? `export function captureMcpAliases(config) {
  const matches = Object.entries(config.mcp ?? {}).filter(([, entry]) => entry?.type === "remote" && entry.url === runtimeParams.mcp?.url);
  const active = matches.filter(([, entry]) => entry.enabled !== false);
  active.sort(([a], [b]) => a === runtimeParams.mcp?.serverName ? -1 : b === runtimeParams.mcp?.serverName ? 1 : 0);
  const aliases = [...active, ...matches.filter(([, entry]) => entry.enabled === false)].map(([name]) => name);
  const aliasesJson = JSON.stringify(aliases).split("").map(char => char.charCodeAt(0) > 127 ? "\\\\u" + char.charCodeAt(0).toString(16).padStart(4, "0") : char).join("");
  return active.length && aliases.length <= 64 && aliasesJson.length <= 8192 ? { "x-archestra-client-runtime-token": runtimeParams.source.token, "x-archestra-mcp-aliases": aliasesJson } : {};
}`
    : ""
}
// white-label-ok: This constant is a stable wire header identifier.
const openCodeAgentHeader = ${JSON.stringify(OPENCODE_AGENT_HEADER)};
const openAiOAuthBridgeHeader = "x-archestra-opencode-oauth-bridge";
const chatGptBaseUrl = "https://chatgpt.com/backend-api/codex";
const normalizeUrl = (value) => String(value ?? "").replace(/\\/+$/, "");
// Providers the organization's credential serves in the current transform.
const managedProviders = new Set();
let managedCredential = "";
// Every credential the client set goes before the managed key is added.
const clientCredentialHeaderNames = ["authorization", "chatgpt-account-id", "x-goog-api-key", "x-api-key", openAiOAuthBridgeHeader];
const stripAliasAuth = (headers) => {
  if (typeof headers.delete === "function") {
    for (const name of clientCredentialHeaderNames) headers.delete(name);
    if (managedCredential) headers.set("Authorization", "Bearer " + managedCredential);
    return;
  }
  for (const key of Object.keys(headers)) if (clientCredentialHeaderNames.includes(key.toLowerCase())) delete headers[key];
  if (managedCredential) headers.Authorization = "Bearer " + managedCredential;
};
const managedAliasTarget = (url) => {
  if (managedProviders.has("openai") && activeRoutes.openai && (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com")) {
    const suffix = url.pathname.endsWith("/backend-api/codex/responses") ? "/responses" : ["/chat/completions", "/responses", "/models"].find((path) => url.pathname.endsWith(path));
    return suffix ? activeRoutes.openai + suffix : "";
  }
  return "";
};
const onManagedAliasRoute = (url) => [...managedProviders].some((id) => {
  const route = activeRoutes[id];
  if (!route) return false;
  const base = new URL(route);
  return base.origin === url.origin && url.pathname.startsWith(base.pathname.replace(/\\/+$/, ""));
});
${params.runtime ? "const directInferencePath = /(?:\\/(?:messages|responses|chat\\/completions)|\\/v1beta\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)|\\/backend-api\\/codex\\/responses)$/;" : ""}

export default {
  id: "archestra.llm-proxy",
  async setup(ctx${params.runtime ? ", bindingProof" : ""}) {
    await ctx.provider.transform(async (editor) => {
      activeRoutes = { ...routes };
      effectiveRouteHeaders = { ...routeHeaders };
      managedProviders.clear();
      const managedKey = readManagedKey();
      managedCredential = managedKey;
      for (const [id, served] of Object.entries(catalogManaged)) {
        const record = editor.get(id);
        // A provider the client does not know cannot be shown without an
        // extra provider of the proxy's own, so there is nothing to filter.
        if (!record || !Object.hasOwn(routes, id) || !managedKey) continue;
        const key = record.provider.settings?.apiKey;
        // The user's own sign-in comes first where the connection allows it.
        const native = catalogPassthrough.includes(id) && (record.sourceConnection ||
          (credentialEnvByProvider[id] ?? []).some((name) => process.env[name]?.trim()) ||
          (typeof key === "string" && key.trim() && key !== managedKey && !key.startsWith("archestra_")));
        if (native) continue;
        managedProviders.add(id);
        effectiveRouteHeaders[id] = {};
        // Stock name, ids and model data stay, as do the user's own headers
        // other than a credential; only the served models, the base URL and
        // the credential change.
        editor.update(id, (provider) => {
          provider.activation = "enabled";
          provider.settings = { ...provider.settings, apiKey: managedKey, baseURL: routes[id] };
          provider.headers = { ...Object.fromEntries(Object.entries(provider.headers ?? {}).filter(([name]) => !clientCredentialHeaderNames.includes(name.toLowerCase()))), ...managedHeaders };
        });
        const models = record.models instanceof Map ? [...record.models.values()] : Object.values(record.models ?? {});
        editor.models.set(id, models.filter((model) => served.includes(model.id)));
      }
      for (const record of editor.list()) {
        const providerId = record.provider.id;
        if (Object.hasOwn(activeRoutes, providerId)) continue;
        editor.update(providerId, (provider) => {
          provider.activation = "disabled";
        });
      }
    });
    await ctx.session.hook("model.request", (event) => {
      const providerId = event.model.providerID;
      const route = Object.hasOwn(activeRoutes, providerId) ? activeRoutes[providerId] : undefined;
      if (!route) {
        throw new Error(
          'OpenCode provider "' + providerId + '" is not supported by the connected ' + appName + ' LLM proxy. Disconnect or reconfigure the proxy before using it.',
        );
      }
      const managedAlias = managedProviders.has(providerId);
      const chatGptSignIn = !managedAlias && providerId === "openai" && normalizeUrl(event.baseURL) === chatGptBaseUrl;
      event.baseURL = route;
      ${params.runtime ? 'delete event.headers["x-archestra-client-runtime-token"];\n      delete event.headers["x-archestra-mcp-aliases"];' : ""}
      Object.assign(event.headers, managedHeaders, effectiveRouteHeaders[providerId] ?? {});
      event.headers[openCodeAgentHeader] = event.agent;
      if (managedAlias) stripAliasAuth(event.headers);
      else if (chatGptSignIn) event.headers[openAiOAuthBridgeHeader] = "true";
    });
    ${
      params.runtime
        ? `await ctx.session.hook("http.request", event => {
      const request = event.request;
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete("x-archestra-client-runtime-token");
      headers.delete("x-archestra-mcp-aliases");
      const rewritten = managedAliasTarget(url);
      const finalUrl = rewritten ? new URL(rewritten) : url;
      if (rewritten || onManagedAliasRoute(finalUrl)) stripAliasAuth(headers);
      const managedRoute = Object.values(activeRoutes).some(route => {
        const base = new URL(route);
        return base.origin === finalUrl.origin && finalUrl.pathname.startsWith(base.pathname.replace(/\\/+$/, "") + "/");
      });
      if (finalUrl.protocol === "https:" && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && finalUrl.origin === runtimeParams.origin && managedRoute && directInferencePath.test(finalUrl.pathname)) {
        for (const [name, value] of Object.entries(bindingProof?.() ?? {})) headers.set(name, value);
      }
      event.request = rewritten
        ? new Request(rewritten, { method: request.method, headers, body: request.body, signal: request.signal, duplex: request.body ? "half" : undefined, redirect: headers.has("x-archestra-client-runtime-token") ? "error" : request.redirect })
        : new Request(request, { headers, redirect: headers.has("x-archestra-client-runtime-token") ? "error" : request.redirect });
    });`
        : ""
    }
  },
};
`;
}

/**
 * Route headers for a runtime plugin. Setup stores the passthrough key in
 * `passthroughHeaders`; older setups stored it only beside each passthrough
 * route they knew. A passthrough route in the deployment's catalog without
 * an entry of its own, such as a provider routed after setup, takes that key;
 * without it the proxy rejects the user's own sign-in there.
 */
const RUNTIME_ROUTE_HEADERS = `const installedRouteHeaders = runtimeParams.routeHeaders ?? {};
const nonEmptyHeaders = (headers) => headers && Object.keys(headers).length > 0 ? headers : undefined;
const passthroughKeyOnly = (headers) => nonEmptyHeaders(Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() === ${JSON.stringify(VIRTUAL_KEY_HEADER.toLowerCase())})));
const passthroughHeaders = nonEmptyHeaders(runtimeParams.passthroughHeaders) ?? Object.values(installedRouteHeaders).map(passthroughKeyOnly).find(Boolean);
const routeHeaders = passthroughHeaders
  ? { ...installedRouteHeaders, ...Object.fromEntries(catalogPassthrough.map((id) => [id, nonEmptyHeaders(installedRouteHeaders[id]) ?? passthroughHeaders])) }
  : installedRouteHeaders;`;

function catalogSource(params: RenderOpenCodeRoutingPluginParams): string {
  const catalog = params.catalog;
  return `const catalogRoutes = ${JSON.stringify(catalog?.routes ?? {})};
const catalogManaged = ${JSON.stringify(catalog?.managed ?? {})};
const catalogPassthrough = ${JSON.stringify(catalog?.passthrough ?? [])};
const legacyProviderIds = ${JSON.stringify(catalog?.legacy ?? {})};
const hasCatalog = ${JSON.stringify(params.catalog !== undefined)};`;
}

const OPENCODE_CREDENTIAL_ENV_BY_PROVIDER: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  zhipuai: ["ZHIPU_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  xai: ["XAI_API_KEY"],
};
