import { DEFAULT_APP_NAME, OPENCODE_AGENT_HEADER } from "@archestra/shared";
import { OPENCODE_CLIENT, type OpenCodeFamilyClient } from "../opencode-family";

// white-label-ok: stable OpenCode V1 plugin export, not display copy
export const OPENCODE_V1_PROXY_EXPORT = "ArchestraLlmProxy";
// white-label-ok: stable OpenCode V1 OAuth plugin export, not display copy
export const OPENCODE_V1_OAUTH_EXPORT = "ArchestraOpenAiOAuth";

interface RenderOpenCodeRoutingPluginParams {
  /** Managed implementations read credentials from the private installation file. */
  runtime?: boolean;
  /** Deployment name for user-facing errors. Runtime copies read it from params. */
  appName?: string;
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
  const { dir, label } = params.client ?? OPENCODE_CLIENT;
  // The client values go in before the wire-header constant below, so every
  // later line stays covered by its white-label waiver.
  return `import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

${params.runtime ? 'const runtimeParams = JSON.parse(readFileSync(new URL("../params.json", import.meta.url), "utf8"));' : ""}
const routes = ${params.runtime ? "runtimeParams.routes" : JSON.stringify(params.routes)};
let activeRoutes = { ...routes };
const managedHeaders = ${params.runtime ? "{ ...runtimeParams.headers }" : JSON.stringify(params.headers)};
const routeHeaders = ${params.runtime ? "runtimeParams.routeHeaders ?? {}" : JSON.stringify(params.routeHeaders ?? {})};
const providerTwins = ${params.runtime ? "runtimeParams.providerTwins ?? {}" : JSON.stringify(params.providerTwins ?? {})};
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
const headersFor = (providerId) => ({ ...managedHeaders, ...(routeHeaders[providerId] ?? {}) });
const credentialEnvByProvider = ${JSON.stringify(OPENCODE_CREDENTIAL_ENV_BY_PROVIDER)};
const normalizeUrl = (value) => String(value ?? "").replace(/\\/+$/, "");

const directInferencePath = /(?:\\/(?:messages|responses|chat\\/completions)|\\/v1beta\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)|\\/backend-api\\/codex\\/responses)$/;
const fetchGuardSymbol = Symbol.for("archestra.opencode.llmProxyFetchGuard");
const openAiOAuthBridgeHeader = "x-archestra-opencode-oauth-bridge";
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

if (${params.runtime ? "true" : "!globalThis[fetchGuardSymbol]"}) {
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
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
    const eligible = Object.entries(routes).filter(([providerId]) => {
      const apiKey = config.provider[providerId]?.options?.apiKey;
      return usableAuth(localAuth, providerId) || usableEnvironment(providerId) || (typeof apiKey === "string" && apiKey.trim() !== "");
    });
    activeRoutes = Object.fromEntries(eligible);
    proxyOrigins = computeProxyOrigins(activeRoutes);
    // Every routed provider stays listed, signed in or not, so the user can
    // connect one from the client. Only the signed-in ones get a config entry:
    // an entry alone would load a provider that has no credential yet.
    const providerIds = Object.keys(routes);
    config.enabled_providers = providerIds;
    if (Array.isArray(config.disabled_providers)) {
      config.disabled_providers = config.disabled_providers.filter((id) => !providerIds.includes(id));
    }
    for (const [providerId, baseURL] of Object.entries(routes)) {
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
      const providerId = model.split("/", 1)[0];
      if (activeRoutes[providerId]) return model;
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
  },
  ...(googleOAuth ? {
    auth: {
      provider: "google",
      methods: [],
      async loader(auth) {
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
  return `${params.runtime ? 'import { readFileSync } from "node:fs";\nconst runtimeParams = JSON.parse(readFileSync(new URL("../params.json", import.meta.url), "utf8"));\n' : ""}const appName = ${renderedAppName(params)};
const routes = ${params.runtime ? "runtimeParams.routes" : JSON.stringify(params.routes)};
const managedHeaders = ${params.runtime ? "runtimeParams.headers" : JSON.stringify(params.headers)};
const routeHeaders = ${params.runtime ? "runtimeParams.routeHeaders ?? {}" : JSON.stringify(params.routeHeaders ?? {})};
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
${params.runtime ? "const directInferencePath = /(?:\\/(?:messages|responses|chat\\/completions)|\\/v1beta\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)|\\/backend-api\\/codex\\/responses)$/;" : ""}

export default {
  id: "archestra.llm-proxy",
  async setup(ctx${params.runtime ? ", bindingProof" : ""}) {
    await ctx.provider.transform((editor) => {
      for (const record of editor.list()) {
        const providerId = record.provider.id;
        if (Object.hasOwn(routes, providerId)) continue;
        editor.update(providerId, (provider) => {
          provider.activation = "disabled";
        });
      }
    });
    await ctx.session.hook("model.request", (event) => {
      const providerId = event.model.providerID;
      const route = Object.hasOwn(routes, providerId) ? routes[providerId] : undefined;
      if (!route) {
        throw new Error(
          'OpenCode provider "' + providerId + '" is not supported by the connected ' + appName + ' LLM proxy. Disconnect or reconfigure the proxy before using it.',
        );
      }
      const chatGptSignIn = providerId === "openai" && normalizeUrl(event.baseURL) === chatGptBaseUrl;
      event.baseURL = route;
      ${params.runtime ? 'delete event.headers["x-archestra-client-runtime-token"];\n      delete event.headers["x-archestra-mcp-aliases"];' : ""}
      Object.assign(event.headers, managedHeaders, routeHeaders[providerId] ?? {});
      event.headers[openCodeAgentHeader] = event.agent;
      if (chatGptSignIn) event.headers[openAiOAuthBridgeHeader] = "true";
    });
    ${
      params.runtime
        ? `await ctx.session.hook("http.request", event => {
      const request = event.request;
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete("x-archestra-client-runtime-token");
      headers.delete("x-archestra-mcp-aliases");
      const managedRoute = Object.values(routes).some(route => {
        const base = new URL(route);
        return base.origin === url.origin && url.pathname.startsWith(base.pathname.replace(/\\/+$/, "") + "/");
      });
      if (url.protocol === "https:" && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && url.origin === runtimeParams.origin && managedRoute && directInferencePath.test(url.pathname)) {
        for (const [name, value] of Object.entries(bindingProof?.() ?? {})) headers.set(name, value);
      }
      event.request = new Request(request, { headers, redirect: headers.has("x-archestra-client-runtime-token") ? "error" : request.redirect });
    });`
        : ""
    }
  },
};
`;
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
