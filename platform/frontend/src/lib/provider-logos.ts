import type {
  SubscriptionCredentialKind,
  SupportedProvider,
} from "@archestra/shared";

/**
 * Map our provider names to logo file names. The names follow models.dev
 * provider IDs (https://github.com/anomalyco/models.dev/tree/dev/providers),
 * but the SVGs are bundled under `public/model-logos/` and served from our own
 * origin so icons render even when third-party requests are blocked (mobile
 * content blockers, restrictive networks, air-gapped deployments).
 *
 * All logos must be monochrome (black / currentColor): the render sites apply
 * `dark:invert`, which would distort a colored logo. Most files come from
 * models.dev; the three providers models.dev has no logo for are sourced
 * elsewhere — `archestra.svg` is our own brand icon (same mark as
 * `logo-icon.svg`), `vllm.svg` and `microsoft-365-copilot.svg` are the
 * monochrome marks from @lobehub/icons-static-svg. `xai.svg` is the same
 * geometric X as models.dev, cropped to fill a square slot the way the
 * other provider marks do.
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
  // models.dev has no Voyage provider; this is the monochrome mark from
  // @lobehub/icons-static-svg, same source as vllm/microsoft-365-copilot.
  voyage: "voyage",
};

export function providerLogoUrl(provider: SupportedProvider): string {
  return `/model-logos/${providerToLogoProvider[provider]}.svg`;
}

/**
 * SuperGrok credentials still live on the `xai` provider. Surfaces that know
 * the selected key is a SuperGrok subscription should show Grok's mark instead
 * of the xAI X.
 */
export function logoNameForProvider(
  provider: SupportedProvider,
  subscriptionKind?: SubscriptionCredentialKind | null,
): string {
  if (subscriptionKind === "x-premium") {
    return "grok";
  }
  return providerToLogoProvider[provider];
}
