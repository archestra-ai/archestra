/** Prices in USD per 1 million tokens */
export const llmPricing = {
  openai: {
    "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
    "codex-mini": { input: 1.5, output: 6, cachedInput: 0.38 },
    "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
    "gpt-3.5-turbo-16k": { input: 3, output: 4 },
    "gpt-3.5-turbo-instruct": { input: 1.5, output: 2 },
    "gpt-4": { input: 30, output: 60 },
    "gpt-4-turbo": { input: 10, output: 30 },
    "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.03 },
    "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.08 },
    "gpt-4o:extended": { input: 6, output: 18 },
    "gpt-5": { input: 1.25, output: 10, cachedInput: 0.13 },
    "gpt-5-chat": { input: 1.25, output: 10, cachedInput: 0.13 },
    "gpt-5-codex": { input: 1.25, output: 10, cachedInput: 0.13 },
    "gpt-5-image": { input: 10, output: 10, cachedInput: 1.25 },
    "gpt-5-image-mini": { input: 2.5, output: 2, cachedInput: 0.25 },
    "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.03 },
    "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.01 },
    "gpt-5-pro": { input: 15, output: 120 },
    "gpt-oss-120b": { input: 0.04, output: 0.4 },
    "gpt-oss-120b:exacto": { input: 0.05, output: 0.24 },
    "gpt-oss-20b": { input: 0.03, output: 0.14 },
    "gpt-oss-20b:free": { input: 0, output: 0 },
    "gpt-oss-safeguard-20b": { input: 0.08, output: 0.3, cachedInput: 0.04 },
    o1: { input: 15, output: 60, cachedInput: 7.5 },
    "o1-pro": { input: 150, output: 600 },
    o3: { input: 2, output: 8, cachedInput: 0.5 },
    "o3-deep-research": { input: 10, output: 40, cachedInput: 2.5 },
    "o3-mini": { input: 1.1, output: 4.4, cachedInput: 0.55 },
    "o3-mini-high": { input: 1.1, output: 4.4, cachedInput: 0.55 },
    "o3-pro": { input: 20, output: 80 },
    "o4-mini": { input: 1.1, output: 4.4, cachedInput: 0.28 },
    "o4-mini-deep-research": { input: 2, output: 8, cachedInput: 0.5 },
    "o4-mini-high": { input: 1.1, output: 4.4, cachedInput: 0.28 },
  },
  anthropic: {
    // Claude 4.1
    "claude-opus-4.1": { input: 15, output: 75, cachedInput: 18.75 },
    // Claude 4.5
    "claude-sonnet-4.5": { input: 3, output: 15, cachedInput: 3.75 },
    "claude-haiku-4.5": { input: 1, output: 5, cachedInput: 1.25 },
    // Claude 4 (legacy)
    "claude-opus-4": { input: 15, output: 75, cachedInput: 18.75 },
    "claude-sonnet-4": { input: 3, output: 15, cachedInput: 3.75 },
    // Claude 3.7
    "claude-sonnet-3.7": { input: 3, output: 15, cachedInput: 3.75 },
    // Claude 3.5
    "claude-3.5-sonnet": { input: 3, output: 15, cachedInput: 3.75 },
    "claude-3.5-haiku": { input: 0.8, output: 4, cachedInput: 1 },
    // Claude 3
    "claude-3-opus": { input: 15, output: 75, cachedInput: 18.75 },
    "claude-3-sonnet": { input: 3, output: 15, cachedInput: 3.75 },
    "claude-3-haiku": { input: 0.25, output: 1.25, cachedInput: 0.3 },
  },
} as const;

export function isOpenAIPricingModel(
  model: string,
): model is keyof typeof llmPricing.openai {
  return model in llmPricing.openai;
}
export function isAnthropicPricingModel(
  model: string,
): model is keyof typeof llmPricing.anthropic {
  return model in llmPricing.anthropic;
}
