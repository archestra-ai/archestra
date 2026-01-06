import type { SupportedProvider } from "@shared";
import { AnthropicTokenizer } from "./anthropic";
import type { Tokenizer } from "./base";
import { TiktokenTokenizer } from "./tiktoken";

export { AnthropicTokenizer } from "./anthropic";
export { BaseTokenizer, type ProviderMessage, type Tokenizer } from "./base";
export { TiktokenTokenizer } from "./tiktoken";

/**
 * Get the tokenizer for a given provider
 */
export function getTokenizer(provider: SupportedProvider): Tokenizer {
  switch (provider) {
    case "anthropic":
      return new AnthropicTokenizer();
    case "openai":
      return new TiktokenTokenizer();
    case "minimax":
      return new TiktokenTokenizer();
    default:
      return new TiktokenTokenizer();
  }
}
