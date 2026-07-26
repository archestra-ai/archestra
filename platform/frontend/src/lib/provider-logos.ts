import type { SupportedProvider } from "@archestra/shared";

/**
 * Map our provider names to logo file names. The names follow models.dev
 * provider IDs (https://github.com/anomalyco/models.dev/tree/dev/providers),
 * but the SVGs are bundled under `public/model-logos/` and served from our own
 * origin so icons render even when third-party requests are blocked (mobile
 * content blockers, restrictive networks, air-gapped deployments).
 */
export const providerToLogoProvider: Record<SupportedProvider, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  bedrock: "amazon-bedrock",
  cerebras: "cerebras",
  cohere: "cohere",
  mistral: "mistral",
  perplexity: "perplexity",
  groq: "groq",
  xai: "xai",
  openrouter: "openrouter",
  vllm: "vllm",
  ollama: "ollama-cloud", // models.dev uses ollama-cloud for the Ollama provider
  "ollama-native": "ollama-cloud",
  zhipuai: "zhipuai",
  deepseek: "deepseek",
  minimax: "minimax",
  kimi: "moonshotai",
  azure: "azure",
  "github-copilot": "github-copilot",
  "microsoft-365-copilot": "microsoft-365-copilot",
  archestra: "archestra",
};

export function providerLogoUrl(provider: SupportedProvider): string {
  return `/model-logos/${providerToLogoProvider[provider]}.svg`;
}
