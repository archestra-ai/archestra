import type { SupportedProvider } from "@archestra/shared";
import { AnthropicTokenizer } from "./anthropic";
import type { Tokenizer } from "./base";
import { TiktokenTokenizer } from "./tiktoken";

export { AnthropicTokenizer } from "./anthropic";
export { BaseTokenizer, type ProviderMessage, type Tokenizer } from "./base";
export { TiktokenTokenizer } from "./tiktoken";

/**
 * Get the tokenizer for a given provider.
 *
 * Tokenizer instances are cached and shared process-wide. This matters for
 * {@link TiktokenTokenizer}: its constructor allocates a `tiktoken` encoding
 * that holds WASM heap and is never freed, so instantiating one per call both
 * re-pays the encoding init cost and leaks native memory. The tokenizers carry
 * no per-call state beyond that encoding, so a single shared instance is safe.
 */
export function getTokenizer(provider: SupportedProvider): Tokenizer {
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
 * Maps each provider to a cached tokenizer accessor.
 * Using Record<SupportedProvider, ...> ensures TypeScript enforces adding new providers here.
 */
const tokenizerCache: Record<SupportedProvider, () => Tokenizer> = {
  anthropic: getAnthropicTokenizer,
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
  zhipuai: getTiktokenTokenizer,
  deepseek: getTiktokenTokenizer,
  "github-copilot": getTiktokenTokenizer,
  gemini: getTiktokenTokenizer,
  bedrock: getTiktokenTokenizer,
  minimax: getTiktokenTokenizer,
};
