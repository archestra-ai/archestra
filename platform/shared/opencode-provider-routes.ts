import {
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
  type SupportedProvider,
} from "./model-constants";

/**
 * Virtual keys also support providers translated by the Model Router. Microsoft
 * 365 Copilot is left out: its proxy adapter rejects every request that carries
 * tools, and OpenCode sends tools on each agent turn.
 */
export const OPENCODE_PRIMARY_PROVIDERS: readonly SupportedProvider[] = [
  ...MODEL_ROUTER_SUPPORTED_PROVIDERS,
  "kimi",
  "archestra",
];

export interface OpenCodeProviderRoute {
  provider: SupportedProvider;
  openCodeProviderId: string;
  pathSuffix: string;
  /**
   * Other native provider ids (models.dev) that serve the same models as the
   * Archestra provider. A model pinned under one of them moves to the
   * Archestra twin on connect and back on disconnect; they never get a
   * passthrough route of their own.
   */
  pinAliases?: readonly string[];
}

/**
 * Native OpenCode providers whose request wire and credential transport match an
 * Archestra provider endpoint. These overrides preserve provider and model IDs
 * and local credentials. They only replace the upstream base URL. Each mapped
 * Archestra route forwards native chat model IDs to the proxy.
 */
export const OPENCODE_PASSTHROUGH_PROVIDER_ROUTES = [
  {
    provider: "anthropic",
    openCodeProviderId: "anthropic",
    pathSuffix: "/v1",
  },
  {
    provider: "gemini",
    openCodeProviderId: "google",
    pathSuffix: "/v1beta",
  },
  { provider: "openai", openCodeProviderId: "openai", pathSuffix: "" },
  { provider: "cerebras", openCodeProviderId: "cerebras", pathSuffix: "" },
  { provider: "mistral", openCodeProviderId: "mistral", pathSuffix: "" },
  { provider: "groq", openCodeProviderId: "groq", pathSuffix: "" },
  {
    provider: "openrouter",
    openCodeProviderId: "openrouter",
    pathSuffix: "",
  },
  { provider: "deepseek", openCodeProviderId: "deepseek", pathSuffix: "" },
  { provider: "zhipuai", openCodeProviderId: "zhipuai", pathSuffix: "" },
  { provider: "minimax", openCodeProviderId: "minimax", pathSuffix: "" },
  {
    provider: "kimi",
    openCodeProviderId: "moonshotai",
    pathSuffix: "",
    // The Kimi Code plan providers (kimi.ai and kimi.com) carry the same k3
    // family as the Kimi provider here; Kilo Code pins its compaction agent
    // to one of them.
    pinAliases: ["kimi-code-plan-global", "kimi-code-plan-cn"],
  },
] as const satisfies readonly OpenCodeProviderRoute[];

export function openCodePassthroughBaseUrl(
  baseUrl: string,
  route: OpenCodeProviderRoute,
): string {
  return `${baseUrl.replace(/\/$/, "")}/${route.provider}${route.pathSuffix}`;
}
