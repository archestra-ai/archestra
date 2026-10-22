import { DEFAULT_APP_NAME, OPENCODE_AGENT_HEADER } from "@archestra/shared";
import { OPENCODE_CLIENT, type OpenCodeFamilyClient } from "../opencode-family";
import type { ManagedRuntimeCatalog } from "./opencode-primary-config";
import { OPENCODE_QUESTION_TUI } from "./opencode-question-tui";

// white-label-ok: stable OpenCode V1 plugin export, not display copy
export const OPENCODE_V1_PROXY_EXPORT = "ArchestraLlmProxy";
// white-label-ok: stable OpenCode V1 OAuth plugin export, not display copy
export const OPENCODE_V1_OAUTH_EXPORT = "ArchestraOpenAiOAuth";

interface RenderOpenCodeRoutingPluginParams {
  /** Managed implementations read credentials from the private installation file. */
  runtime?: boolean;
  /** Deployment name for user-facing errors. Runtime copies read it from params. */
  appName?: string;
  /** Public provider/model definitions. Credentials stay in the local runtime file. */
  catalog?: ManagedRuntimeCatalog;
  routes: Record<string, string>;
  headers: Record<string, string>;
  /**
   * Extra headers for one route only, keyed by provider id: the passthrough
   * key goes on providers that sign in with the user's own credential, never
   * on a provider that already authenticates with a virtual key.
   */
  routeHeaders?: Record<string, Record<string, string>>;
  /**
   * Native provider id → the routed Archestra provider that serves the same
   * models, so a model pinned under a native id (kimi-code-plan-global/k3)
   * moves to its twin (archestra-kimi/k3) instead of failing as not found.
   */
  providerTwins?: Record<string, string>;
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
  const { dir, label, modelsPathEnv } = params.client ?? OPENCODE_CLIENT;
  // The client values go in before the wire-header constant below, so every
  // later line stays covered by its white-label waiver.
  return `import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

${params.runtime ? 'const runtimeParams = JSON.parse(readFileSync(new URL("../params.json", import.meta.url), "utf8"));' : ""}
${params.runtime ? OPENCODE_QUESTION_TUI : ""}
${catalogSource(params)}
const installedRoutes = ${params.runtime ? "runtimeParams.routes ?? {}" : JSON.stringify(params.routes)};
const routes = hasCatalog ? { ...catalogRoutes } : { ...installedRoutes };
let activeRoutes = { ...routes };
let runtimeRoutes = { ...routes };
const managedHeaders = ${params.runtime ? "{ ...runtimeParams.headers }" : JSON.stringify(params.headers)};
const routeHeaders = ${params.runtime ? "runtimeParams.routeHeaders ?? {}" : JSON.stringify(params.routeHeaders ?? {})};
let effectiveRouteHeaders = { ...routeHeaders };
const providerTwins = hasCatalog ? catalogTwins : ${params.runtime ? "runtimeParams.providerTwins ?? {}" : JSON.stringify(params.providerTwins ?? {})};
const aliasKeys = new Map();
const aliasOriginals = new Map();
const readManagedKey = () => {
  ${
    params.runtime
      ? `const file = runtimeParams.managedKeyPath ?? join(homedir(), ".archestra", ${JSON.stringify(`${(params.client ?? OPENCODE_CLIENT).stateName}-primary.key`)});
  if (typeof file === "string" && file) {
    try { const value = readFileSync(file, "utf8").trim(); if (value) return value; } catch {}
  }
  return typeof runtimeParams.managedKey === "string" ? runtimeParams.managedKey.trim() : "";`
      : 'return "";'
  }
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
// The label the user knows a provider by: the name they configured, else the
// one in the client's cached models.dev catalog, else its id.
const clientCatalogPath = process.env[${JSON.stringify(modelsPathEnv)}] || join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), clientDir, "models.json");
// Read once. A missing or half-written file is retried on the next config
// load, not once per alias.
let clientCatalog;
const clientProviderLabel = (providerId, configured) => {
  if (typeof configured?.name === "string" && configured.name.trim()) return configured.name;
  if (clientCatalog === undefined) {
    try { const parsed = JSON.parse(readFileSync(clientCatalogPath, "utf8")); clientCatalog = parsed && typeof parsed === "object" ? parsed : {}; }
    catch { clientCatalog = null; }
  }
  const name = clientCatalog?.[providerId]?.name;
  return typeof name === "string" && name.trim() ? name : providerId;
};
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
const managedAuth = (id) => ({ apiKey: aliasKeys.get(id), baseURL: activeRoutes[id],
  fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (!activeRoutes[id]) throw new Error("Unsupported managed authentication request.");
    if (/\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(url.pathname)) {
      throw new Error("Managed " + id + " uses the OpenAI model router, which does not accept Gemini generateContent.");
    }
    const suffix = ["/chat/completions", "/responses", "/models"].find((path) => url.pathname.endsWith(path));
    if (!suffix) throw new Error("Unsupported managed authentication request.");
    const headers = new Headers(request.headers);
    for (const name of [...clientCredentialHeaders, managedAliasHeader]) headers.delete(name);
    headers.set("Authorization", "Bearer " + aliasKeys.get(id));
    for (const [name, value] of Object.entries(headersFor(id))) headers.set(name, value);
    return directFetch(new Request(activeRoutes[id] + suffix, { method: request.method, headers, body: request.body, signal: request.signal, duplex: request.body ? "half" : undefined }));
  },
});
// The client's own sign-in for an aliased provider can replace the managed
// key with its own token: Kilo Code does this after an xAI sign-in. The
// managed route accepts only the managed key, so that token never goes there.
const withManagedAliasKey = (request, url, alias) => {
  const headers = new Headers(request.headers);
  headers.delete(managedAliasHeader);
  const route = aliasKeys.has(alias) ? activeRoutes[alias] : undefined;
  const base = route ? new URL(route) : undefined;
  if (base && base.origin === url.origin && url.pathname.startsWith(base.pathname.replace(/\\/+$/, "") + "/")) {
    for (const name of clientCredentialHeaders) headers.delete(name);
    const key = aliasKeys.get(alias);
    if (key) headers.set("Authorization", "Bearer " + key);
  }
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
  headers.delete("x-archestra-question-cards");
  const managedRoute = Object.values(activeRoutes).some(route => {
    const base = new URL(route);
    return base.origin === url.origin && url.pathname.startsWith(base.pathname.replace(/\\/+$/, "") + "/");
  });
  if (url.protocol === "https:" && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && url.origin === runtimeParams.origin && managedRoute && directInferencePath.test(url.pathname) && mcpConnected()) {
    const binding = sessionBindingProofs.get(headers.get("x-opencode-session"));
    if (runtimeParams.questionCards && binding?.origin === url.origin && binding.headers["x-archestra-client-runtime-token"]) headers.set("x-archestra-question-cards", "1");
    for (const [name, value] of Object.entries(binding?.origin === url.origin ? binding.headers : {})) headers.set(name, value);
  }
  return rawDirectFetch(new Request(request, { headers, redirect: headers.has("x-archestra-client-runtime-token") ? "error" : request.redirect }));
}`
      : "rawDirectFetch"
  };
const computeProxyOrigins = (routesMap) => new Set(Object.values(routesMap).map((value) => new URL(value).origin));
let proxyOrigins = computeProxyOrigins(activeRoutes);

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
    if (clientCatalog === null) clientCatalog = undefined;
    config.provider ??= {};
    const localAuth = readLocalAuth();
    const signedInToOpenAi = localAuth.openai?.type === "oauth";
    const managedKey = readManagedKey();
    if (hasCatalog) {
      runtimeRoutes = { ...routes };
      effectiveRouteHeaders = { ...routeHeaders };
      for (const [id, definition] of Object.entries(catalogProviders)) {
        if (!routes[id]) continue;
        const previous = config.provider[id] ?? {};
        config.provider[id] = { ...previous, name: definition.name ?? previous.name, npm: definition.npm ?? previous.npm,
          options: { baseURL: routes[id], ...(managedKey ? { apiKey: managedKey } : {}), headers: {} },
          models: Object.fromEntries(Object.entries(definition.models ?? {}).map(([modelId, model]) => [modelId, { name: model.name ?? modelId, id: model.id ?? modelId, ...(model.limit ? { limit: model.limit } : {}),
            ...(model.modalities ? { modalities: model.modalities } : {}), ...(typeof model.attachment === "boolean" ? { attachment: model.attachment } : {}) }])),
        };
      }
      const nativeCredential = (providerId) => {
        const key = config.provider[providerId]?.options?.apiKey;
        return usableAuth(localAuth, providerId) || usableEnvironment(providerId) ||
          (typeof key === "string" && key.trim() !== "" && key !== aliasKeys.get(providerId) && key !== managedKey && !key.startsWith("archestra_"));
      };
      const native = new Set(Object.keys(routes).filter((id) => !id.startsWith("archestra-") && nativeCredential(id)));
      for (const [alias, twin] of Object.entries(providerTwins)) {
        if (native.has(alias)) {
          if (aliasKeys.has(alias) && config.provider[alias]?.options?.apiKey === aliasKeys.get(alias)) {
            const original = aliasOriginals.get(alias);
            if (original) config.provider[alias] = original; else delete config.provider[alias];
          }
          aliasKeys.delete(alias); aliasOriginals.delete(alias);
          if (Object.hasOwn(routes, alias)) effectiveRouteHeaders[alias] = routeHeaders[alias] ?? {};
          else delete runtimeRoutes[alias];
          continue;
        }
        const definition = catalogProviders[twin];
        if (!definition || !routes[twin]) continue;
        if (!aliasOriginals.has(alias)) aliasOriginals.set(alias, config.provider[alias]);
        const previous = config.provider[alias] ?? {};
        config.provider[alias] = { ...previous, name: managedAliasName(clientProviderLabel(alias, aliasOriginals.get(alias)), twin), npm: definition.npm,
          options: { baseURL: routes[twin], ...(managedKey ? { apiKey: managedKey } : {}), headers: {} },
          models: { ...(definition.models ?? {}) }, whitelist: Object.keys(definition.models ?? {}),
        };
        aliasKeys.set(alias, managedKey);
        runtimeRoutes[alias] = routes[twin];
        effectiveRouteHeaders[alias] = {};
      }
    }
    const eligible = Object.entries(runtimeRoutes).filter(([providerId]) => {
      const apiKey = config.provider[providerId]?.options?.apiKey;
      return usableAuth(localAuth, providerId) || usableEnvironment(providerId) || (typeof apiKey === "string" && apiKey.trim() !== "");
    });
    activeRoutes = Object.fromEntries(eligible);
    proxyOrigins = computeProxyOrigins(activeRoutes);
    // Every routed provider stays listed, signed in or not, so the user can
    // connect one from the client. Only the signed-in ones get a config entry:
    // an entry alone would load a provider that has no credential yet.
    const providerIds = Object.keys(runtimeRoutes);
    config.enabled_providers = providerIds;
    if (Array.isArray(config.disabled_providers)) {
      config.disabled_providers = config.disabled_providers.filter((id) => !providerIds.includes(id));
    }
    for (const [providerId, baseURL] of Object.entries(runtimeRoutes)) {
      if (!activeRoutes[providerId]) {
        if (normalizeUrl(config.provider[providerId]?.options?.baseURL) === normalizeUrl(baseURL)) {
          delete config.provider[providerId];
        }
        continue;
      }
      const provider = config.provider[providerId] ?? {};
      provider.options ??= {};
      provider.options.baseURL = providerId === "openai" && signedInToOpenAi ? openAiApiBaseUrl : baseURL;
      provider.options.headers = { ...(provider.options.headers ?? {}), ...headersFor(providerId) };
      config.provider[providerId] = provider;
    }
    // A model pinned to a provider the connection does not route would fail
    // its turn with "Model not found": the default model, the small model,
    // and an agent's own model (Kilo Code pins its compaction agent to a Kimi
    // plan model, a subagent may be pinned to another vendor). The pin moves
    // to the routed twin that serves the same models; without one it is
    // dropped and the client falls back to the session's model.
    const rehome = (model) => {
      if (typeof model !== "string") return model;
      const slash = model.indexOf("/");
      const providerId = slash > 0 ? model.slice(0, slash) : model;
      const modelId = slash > 0 ? model.slice(slash + 1) : "";
      const listed = (id) => {
        if (!Object.hasOwn(activeRoutes, id)) return false;
        const models = config.provider[id]?.models;
        if (!hasCatalog || !models) return true;
        return Object.hasOwn(models, modelId);
      };
      if (listed(providerId)) return model;
      if (hasCatalog) return undefined;
      const twin = providerTwins[providerId];
      return twin && activeRoutes[twin] ? twin + model.slice(providerId.length) : undefined;
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
    if (aliasKeys.has(providerId)) output.headers[managedAliasHeader] = providerId;
  },
  ...(googleOAuth ? {
    auth: {
      provider: "google",
      methods: [],
      async loader(auth) {
        if (aliasKeys.has("google")) return managedAuth("google");
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
        if (aliasKeys.has("openai")) return managedAuth("openai");
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
 * - providers without a managed route are disabled, matching V1's
 *   enabled_providers list;
 * - the `model.request` hook swaps the base URL and adds the attribution
 *   headers, and fails closed for a provider the proxy cannot route;
 * - a ChatGPT sign-in (OpenAI requests bound for the Codex backend) is marked
 *   with the OAuth bridge header, as V1's fetch bridge did.
 *
 * Pinned models are moved to their Archestra twins by the setup payload for
 * both majors; this variant has no config hook, so a pin added after connect
 * fails closed in `model.request` instead of being moved at load.
 *
 * Inject values only with JSON.stringify. The return value is JavaScript source.
 */
export function renderOpenCodeRoutingPluginV2(
  params: RenderOpenCodeRoutingPluginParams,
): string {
  return `${params.runtime ? 'import { readFileSync } from "node:fs";\nimport { homedir } from "node:os";\nimport { join } from "node:path";\nconst runtimeParams = JSON.parse(readFileSync(new URL("../params.json", import.meta.url), "utf8"));\n' : ""}const appName = ${renderedAppName(params)};
${catalogSource(params)}
const installedRoutes = ${params.runtime ? "runtimeParams.routes ?? {}" : JSON.stringify(params.routes)};
const routes = hasCatalog ? { ...catalogRoutes } : { ...installedRoutes };
let activeRoutes = { ...routes };
const routeHeaders = ${params.runtime ? "runtimeParams.routeHeaders ?? {}" : JSON.stringify(params.routeHeaders ?? {})};
let effectiveRouteHeaders = { ...routeHeaders };
const providerTwins = hasCatalog ? catalogTwins : ${params.runtime ? "runtimeParams.providerTwins ?? {}" : JSON.stringify(params.providerTwins ?? {})};
const managedHeaders = ${params.runtime ? "runtimeParams.headers" : JSON.stringify(params.headers)};
const credentialEnvByProvider = ${JSON.stringify(OPENCODE_CREDENTIAL_ENV_BY_PROVIDER)};
const readManagedKey = () => {
  ${
    params.runtime
      ? `const file = runtimeParams.managedKeyPath ?? join(homedir(), ".archestra", ${JSON.stringify(`${(params.client ?? OPENCODE_CLIENT).stateName}-primary.key`)});
  if (typeof file === "string" && file) {
    try { const value = readFileSync(file, "utf8").trim(); if (value) return value; } catch {}
  }
  return typeof runtimeParams.managedKey === "string" ? runtimeParams.managedKey.trim() : "";`
      : 'return "";'
  }
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
const managedAliases = new Set();
// The client's own label for each alias, taken before the first rename.
const aliasLabels = new Map();
let managedCredential = "";
const stripAliasAuth = (headers) => {
  const names = ["authorization", "chatgpt-account-id", "x-goog-api-key", openAiOAuthBridgeHeader];
  if (typeof headers.delete === "function") {
    for (const name of names) headers.delete(name);
    if (managedCredential) headers.set("Authorization", "Bearer " + managedCredential);
    return;
  }
  for (const key of Object.keys(headers)) if (names.includes(key.toLowerCase())) delete headers[key];
  if (managedCredential) headers.Authorization = "Bearer " + managedCredential;
};
const managedAliasTarget = (url) => {
  if (managedAliases.has("openai") && activeRoutes.openai && (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com")) {
    const suffix = url.pathname.endsWith("/backend-api/codex/responses") ? "/responses" : ["/chat/completions", "/responses", "/models"].find((path) => url.pathname.endsWith(path));
    return suffix ? activeRoutes.openai + suffix : "";
  }
  if (managedAliases.has("google") && /\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(url.pathname)) {
    throw new Error("Managed google uses the OpenAI model router, which does not accept Gemini generateContent.");
  }
  return "";
};
const onManagedAliasRoute = (url) => [...managedAliases].some((id) => {
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
      managedAliases.clear();
      if (hasCatalog && Object.keys(catalogProviders).length) {
        const sdk = await import("@opencode/plugin");
        const managedKey = readManagedKey();
        managedCredential = managedKey;
        const apply = (id, definition, baseURL, headers) => {
          const providerID = sdk.Provider.ID.make(id);
          const models = Object.entries(definition.models ?? {}).map(([modelId, model]) => {
            const defaults = sdk.Model.Info.default(providerID, sdk.Model.ID.make(modelId));
            return { ...defaults, name: model.name ?? modelId, modelID: sdk.Model.ID.make(model.id ?? modelId),
              limit: { ...defaults.limit, ...(model.limit?.context > 0 ? { context: model.limit.context } : {}), ...(model.limit?.output > 0 ? { output: model.limit.output } : {}) },
              ...(model.modalities?.input?.length ? { capabilities: { ...defaults.capabilities, input: [...model.modalities.input] } } : {}),
            };
          });
          const info = { ...sdk.Provider.Info.empty(providerID), name: definition.name ?? id, activation: "enabled",
            package: definition.npm === "@ai-sdk/openai" ? "@opencode/ai/providers/openai" : "@opencode/ai/providers/openai-compatible",
            settings: { ...definition.options, ...(managedKey ? { apiKey: managedKey } : {}), baseURL },
            headers,
          };
          return { info, models };
        };
        for (const [id, definition] of Object.entries(catalogProviders)) {
          if (!routes[id]) continue;
          const next = apply(id, definition, routes[id], { ...managedHeaders, ...(routeHeaders[id] ?? {}) });
          if (editor.get(id)) {
            editor.update(id, (provider) => { Object.assign(provider, next.info, { settings: { ...provider.settings, ...next.info.settings }, headers: { ...next.info.headers } }); });
            editor.models.set(id, next.models);
          } else editor.add(next);
        }
        for (const [alias, twin] of Object.entries(providerTwins)) {
          if (!catalogProviders[twin] || !routes[twin]) continue;
          const record = editor.get(alias);
          if (!aliasLabels.has(alias)) {
            const name = record?.provider.name;
            aliasLabels.set(alias, typeof name === "string" && name.trim() ? name : alias);
          }
          const key = record?.provider.settings?.apiKey;
          const native = Object.hasOwn(routes, alias) && (record?.sourceConnection ||
            (credentialEnvByProvider[alias] ?? []).some((name) => process.env[name]?.trim()) ||
            (typeof key === "string" && key.trim() && key !== managedKey && !key.startsWith("archestra_")));
          if (native) continue;
          managedAliases.add(alias);
          const next = apply(alias, { ...catalogProviders[twin], name: managedAliasName(aliasLabels.get(alias), twin) }, routes[twin], { ...managedHeaders });
          if (record) { editor.update(alias, (provider) => Object.assign(provider, next.info)); editor.models.set(alias, next.models); }
          else editor.add(next);
          activeRoutes[alias] = routes[twin];
          effectiveRouteHeaders[alias] = {};
        }
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
      const managedAlias = managedAliases.has(providerId);
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

function catalogSource(params: RenderOpenCodeRoutingPluginParams): string {
  const catalog = params.catalog;
  const providers = catalog?.providers ?? {};
  const routes = catalog?.routes ?? {};
  const twins = catalog?.twins ?? {};
  const hasCatalog = params.catalog !== undefined;
  return `const catalogProviders = ${JSON.stringify(providers)};
const catalogRoutes = ${JSON.stringify(routes)};
const catalogTwins = ${JSON.stringify(twins)};
const hasCatalog = ${JSON.stringify(hasCatalog)};
// Every alias of one catalog provider lists the same models, so its label
// names both the provider the client knows and the catalog provider behind it.
const managedAliasName = (label, twin) => label + " via " + (catalogProviders[twin]?.name ?? twin);`;
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
};
