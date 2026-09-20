import { OPENCODE_AGENT_HEADER } from "@archestra/shared";

interface RenderOpenCodeRoutingPluginParams {
  routes: Record<string, string>;
  headers: Record<string, string>;
}

/** Renders the global OpenCode plugin that configures and validates managed routes. */
export function renderOpenCodeRoutingPlugin(
  params: RenderOpenCodeRoutingPluginParams,
): string {
  return `import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const routes = ${JSON.stringify(params.routes)};
let activeRoutes = { ...routes };
const managedHeaders = ${JSON.stringify(params.headers)};
const credentialEnvByProvider = ${JSON.stringify(OPENCODE_CREDENTIAL_ENV_BY_PROVIDER)};
const normalizeUrl = (value) => String(value ?? "").replace(/\\/+$/, "");
const directInferencePath = /(?:\\/(?:messages|responses|chat\\/completions)|\\/v1beta\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)|\\/backend-api\\/codex\\/responses)$/;
const fetchGuardSymbol = Symbol.for("archestra.opencode.llmProxyFetchGuard");
const openAiOAuthBridgeHeader = "x-archestra-opencode-oauth-bridge";
const openAiApiBaseUrl = "https://api.openai.com/v1";
// white-label-ok: This constant is a stable wire header identifier.
const openCodeAgentHeader = ${JSON.stringify(OPENCODE_AGENT_HEADER)};
const chatGptResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";

const authPath = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json");
let localAuth = {};
try { localAuth = JSON.parse(readFileSync(authPath, "utf8")); } catch {}
const openAiOAuth = localAuth.openai?.type === "oauth" ? localAuth.openai : null;
const googleOAuth = localAuth.google?.type === "oauth" ? localAuth.google : null;
const usableAuth = (providerId) => {
  const auth = localAuth[providerId];
  if (auth?.type === "api") return typeof auth.key === "string" && auth.key.trim() !== "";
  if (auth?.type !== "oauth") return false;
  return (typeof auth.access === "string" && auth.access.trim() !== "") || (typeof auth.refresh === "string" && auth.refresh.trim() !== "");
};
const usableEnvironment = (providerId) => (credentialEnvByProvider[providerId] ?? [])
  .some((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "");

const directFetchSymbol = Symbol.for("archestra.opencode.directFetch");
const directFetch = globalThis[directFetchSymbol] ?? (globalThis[directFetchSymbol] = globalThis.fetch.bind(globalThis));
const computeProxyOrigins = (routesMap) => new Set(Object.values(routesMap).map((value) => new URL(value).origin));
let proxyOrigins = computeProxyOrigins(activeRoutes);

if (!globalThis[fetchGuardSymbol]) {
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (openAiOAuth && url.href === chatGptResponsesUrl) {
      const target = activeRoutes.openai;
      if (!target) throw new Error("OpenAI OAuth is not supported by the connected Archestra LLM proxy.");
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(managedHeaders)) headers.set(name, value);
      if (!headers.has("Authorization")) throw new Error("OpenAI OAuth request is missing its current bearer token. Refresh the OpenCode OpenAI connection and try again.");
      if (!headers.has("ChatGPT-Account-Id") && openAiOAuth.accountId) headers.set("ChatGPT-Account-Id", openAiOAuth.accountId);
      headers.set(openAiOAuthBridgeHeader, "true");
      return directFetch(new Request(target + "/responses", { method: request.method, headers, body: request.body, signal: request.signal, duplex: request.body ? "half" : undefined }));
    }
    if (!proxyOrigins.has(url.origin) && directInferencePath.test(url.pathname)) {
      throw new Error(
        'Blocked a direct provider inference request to "' + url.origin + '" while OpenCode is connected to the Archestra LLM proxy.',
      );
    }
    return directFetch(request);
  };
  globalThis[fetchGuardSymbol] = true;
}

export const ArchestraLlmProxy = async () => ({
  async config(config) {
    config.provider ??= {};
    const eligible = Object.entries(routes).filter(([providerId]) => {
      const apiKey = config.provider[providerId]?.options?.apiKey;
      return usableAuth(providerId) || usableEnvironment(providerId) || (typeof apiKey === "string" && apiKey.trim() !== "");
    });
    activeRoutes = Object.fromEntries(eligible);
    proxyOrigins = computeProxyOrigins(activeRoutes);
    const providerIds = eligible.map(([providerId]) => providerId);
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
      provider.options.baseURL = providerId === "openai" && openAiOAuth ? openAiApiBaseUrl : baseURL;
      provider.options.headers = { ...(provider.options.headers ?? {}), ...managedHeaders };
      config.provider[providerId] = provider;
    }
    for (const field of ["model", "small_model"]) {
      const providerId = typeof config[field] === "string" ? config[field].split("/", 1)[0] : null;
      if (providerId && !activeRoutes[providerId]) delete config[field];
    }
  },
  async "chat.params"(input) {
    const providerId = input.provider.id ?? input.provider.info?.id;
    const expected = activeRoutes[providerId];
    if (!expected) {
      throw new Error(
        'OpenCode provider "' + providerId + '" is not supported by the connected Archestra LLM proxy. Disconnect or reconfigure the proxy before using it.',
      );
    }
    const actual = input.provider.options?.baseURL;
    const expectedResolved = providerId === "openai" && openAiOAuth ? openAiApiBaseUrl : expected;
    if (normalizeUrl(actual) !== normalizeUrl(expectedResolved)) {
      throw new Error(
        'OpenCode provider "' + providerId + '" resolved to "' + (actual ?? 'no base URL') + '" instead of the connected Archestra endpoint. Re-run the connection setup.',
      );
    }
  },
  async "chat.headers"(input, output) {
    const providerId = input.provider.id ?? input.provider.info?.id;
    if (!activeRoutes[providerId]) return;
    Object.assign(output.headers, managedHeaders);
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
              throw new Error("Google OAuth access token expired. Refresh the OpenCode Google connection and try again.");
            }
            const request = new Request(input, init);
            const headers = new Headers(request.headers);
            headers.delete("x-goog-api-key");
            headers.set("Authorization", "Bearer " + credential.access);
            for (const [name, value] of Object.entries(managedHeaders)) headers.set(name, value);
            if (process.env.GOOGLE_CLOUD_PROJECT) headers.set("x-goog-user-project", process.env.GOOGLE_CLOUD_PROJECT);
            return directFetch(new Request(request, { headers }));
          },
        };
      },
    },
  } : {}),
});

export const ArchestraOpenAiOAuth = async () => ({
  ...(openAiOAuth ? {
    auth: {
      provider: "openai",
      methods: [],
      async loader(auth) {
        const credential = await auth();
        if (!credential || credential.type !== "oauth" || !credential.access) return {};
        const accountId = credential.accountId ?? openAiOAuth.accountId;
        if (!accountId) throw new Error("OpenAI OAuth account ID is missing. Refresh the OpenCode OpenAI connection and try again.");
        return {
          apiKey: "archestra-oauth-bridge",
          fetch: async (input, init) => {
            if (credential.expires && credential.expires <= Date.now()) {
              throw new Error("OpenAI OAuth access token expired. Refresh the OpenCode OpenAI connection and try again.");
            }
            const request = new Request(input, init);
            const headers = new Headers(request.headers);
            headers.set("Authorization", "Bearer " + credential.access);
            headers.set("ChatGPT-Account-Id", accountId);
            headers.set(openAiOAuthBridgeHeader, "true");
            for (const [name, value] of Object.entries(managedHeaders)) headers.set(name, value);
            const target = activeRoutes.openai;
            if (!target) throw new Error("OpenAI OAuth is not supported by the connected Archestra LLM proxy.");
            return directFetch(new Request(target + "/responses", { method: request.method, headers, body: request.body, signal: request.signal, duplex: request.body ? "half" : undefined }));
          },
        };
      },
    },
  } : {}),
});
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
