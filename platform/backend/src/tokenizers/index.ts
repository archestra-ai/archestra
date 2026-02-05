import type { SupportedProvider } from "@shared";
import { AnthropicTokenizer } from "./anthropic";
import type { Tokenizer } from "./base";
import { TiktokenTokenizer } from "./tiktoken";

export { AnthropicTokenizer } from "./anthropic";
export { BaseTokenizer, type ProviderMessage, type Tokenizer } from "./base";
export { TiktokenTokenizer } from "./tiktoken";

/**
 * Maps each provider to a tokenizer factory.
 * Using Record<SupportedProvider, ...> ensures TypeScript enforces adding new providers here.
 */
const tokenizerFactories: Record<SupportedProvider, () => Tokenizer> = {
  anthropic: () => new AnthropicTokenizer(),
  openai: () => new TiktokenTokenizer(),
  cerebras: () => new TiktokenTokenizer(),
  cohere: () => new TiktokenTokenizer(),
  mistral: () => new TiktokenTokenizer(),
  vllm: () => new TiktokenTokenizer(),
  ollama: () => new TiktokenTokenizer(),
  zhipuai: () => new TiktokenTokenizer(),
  gemini: () => new TiktokenTokenizer(),
  bedrock: () => new TiktokenTokenizer(),
};

/**
 * Get the tokenizer for a given provider
 */
export function getTokenizer(provider: SupportedProvider): Tokenizer {
  return tokenizerFactories[provider]();
}
