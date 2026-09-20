import type { SupportedProvider } from "./model-constants";

export interface OpenCodeProviderRoute {
  provider: SupportedProvider;
  openCodeProviderId: string;
  pathSuffix: string;
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
  { provider: "kimi", openCodeProviderId: "moonshotai", pathSuffix: "" },
] as const satisfies readonly OpenCodeProviderRoute[];

export function openCodePassthroughBaseUrl(
  baseUrl: string,
  route: OpenCodeProviderRoute,
): string {
  return `${baseUrl.replace(/\/$/, "")}/${route.provider}${route.pathSuffix}`;
}
