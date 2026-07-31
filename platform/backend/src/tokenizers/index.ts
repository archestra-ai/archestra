import type { SupportedProvider } from "@archestra/shared";
import { AnthropicTokenizer } from "./anthropic";
import type { Tokenizer } from "./base";
import { TiktokenTokenizer } from "./tiktoken";

export { AnthropicTokenizer } from "./anthropic";
export { BaseTokenizer, type ProviderMessage, type Tokenizer } from "./base";
export { TiktokenTokenizer } from "./tiktoken";

/**
 * Get the tokenizer for a given provider, and — for resellers that front more
 * than one vendor's models — the specific model being counted.
 *
 * A reseller's provider id says who serves the model, not who built it, so the
 * provider alone cannot pick the right encoder: Bedrock and OpenRouter both
 * serve Claude. The two encoders agree on plain English and diverge on the
 * code, identifiers and other non-prose that dominate long tool-using
 * conversations — by up to ~17% in either direction, depending on the content.
 * That gap is load-bearing rather than cosmetic: the same estimate decides when
 * auto-compaction fires and whether a turn is let through to the provider, and
 * both comparisons are against *that model's* context window. Measuring Claude
 * with cl100k_base means neither check is answering the question it asks.
 *
 * `modelId` is optional and unknown ids keep the provider default, so a caller
 * that has no model in hand is no worse off than before.
 *
 * Tokenizer instances are cached and shared process-wide. This matters for
 * {@link TiktokenTokenizer}: its constructor allocates a `tiktoken` encoding
 * that holds WASM heap and is never freed, so instantiating one per call both
 * re-pays the encoding init cost and leaks native memory. The tokenizers carry
 * no per-call state beyond that encoding, so a single shared instance is safe.
 */
export function getTokenizer(
  provider: SupportedProvider,
  modelId?: string | null,
): Tokenizer {
  if (modelId && isAnthropicModelOnReseller(provider, modelId)) {
    return getAnthropicTokenizer();
  }
  return tokenizerCache[provider]();
}

// The tiktoken-backed providers all use the same cl100k_base encoding, so they
// share one instance rather than one per provider.
let tiktokenTokenizer: TiktokenTokenizer | undefined;
let anthropicTokenizer: AnthropicTokenizer | undefined;

const getTiktokenTokenizer = (): TiktokenTokenizer =>
  (tiktokenTokenizer ??= new TiktokenTokenizer());
const getAnthropicTokenizer = (): AnthropicTokenizer =>
  (anthropicTokenizer ??= new AnthropicTokenizer());

/**
 * Whether a reseller-hosted model is an Anthropic one.
 *
 * Bedrock ids carry the vendor as the segment after an optional region prefix
 * (`us.anthropic.claude-opus-4-8`, `global.anthropic.…`, or bare
 * `anthropic.claude-…`); OpenRouter uses a `anthropic/…` vendor path. Providers
 * that front a single vendor are deliberately absent — Azure serves OpenAI
 * models, which cl100k_base already counts correctly.
 */
function isAnthropicModelOnReseller(
  provider: SupportedProvider,
  modelId: string,
): boolean {
  const id = modelId.toLowerCase();
  if (provider === "bedrock") {
    return id.replace(BEDROCK_REGION_PREFIX, "").startsWith("anthropic.");
  }
  if (provider === "openrouter") {
    return id.startsWith("anthropic/");
  }
  return false;
}

/** Optional region/geography prefix on a Bedrock inference-profile id. */
const BEDROCK_REGION_PREFIX = /^(us-gov|us|eu|apac|ap|sa|ca|jp|au|global)\./;

/**
 * Maps each provider to a cached tokenizer accessor.
 * Using Record<SupportedProvider, ...> ensures TypeScript enforces adding new providers here.
 */
const tokenizerCache: Record<SupportedProvider, () => Tokenizer> = {
  anthropic: getAnthropicTokenizer,
  archestra: getTiktokenTokenizer,
  azure: getTiktokenTokenizer,
  openai: getTiktokenTokenizer,
  cerebras: getTiktokenTokenizer,
  cohere: getTiktokenTokenizer,
  mistral: getTiktokenTokenizer,
  perplexity: getTiktokenTokenizer,
  groq: getTiktokenTokenizer,
  xai: getTiktokenTokenizer,
  openrouter: getTiktokenTokenizer,
  vllm: getTiktokenTokenizer,
  ollama: getTiktokenTokenizer,
  "ollama-native": getTiktokenTokenizer,
  zhipuai: getTiktokenTokenizer,
  deepseek: getTiktokenTokenizer,
  kimi: getTiktokenTokenizer,
  "github-copilot": getTiktokenTokenizer,
  "microsoft-365-copilot": getTiktokenTokenizer,
  gemini: getTiktokenTokenizer,
  bedrock: getTiktokenTokenizer,
  minimax: getTiktokenTokenizer,
};
