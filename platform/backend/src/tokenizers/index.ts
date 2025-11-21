import type { SupportedProvider } from "@/types";
import { AnthropicTokenizer } from "./anthropic";
import type { Tokenizer } from "./base";
import { TiktokenTokenizer } from "./tiktoken";

export { AnthropicTokenizer } from "./anthropic";
export { BaseTokenizer, type ProviderMessage, type Tokenizer } from "./base";
export { TiktokenTokenizer } from "./tiktoken";

/**
 * Get the appropriate tokenizer for a given provider
 *
 * @param provider - The LLM provider (openai, anthropic, gemini)
 * @returns A tokenizer instance
 *
 * @example
 * ```typescript
 * const tokenizer = getTokenizerForProvider("anthropic");
 * const tokenCount = tokenizer.countMessagesTokens(messages);
 * ```
 */
export function getTokenizerForProvider(
  provider: SupportedProvider,
): Tokenizer {
  switch (provider) {
    case "anthropic":
      return new AnthropicTokenizer();
    case "openai":
      return new TiktokenTokenizer();
    case "gemini":
      // Gemini uses tiktoken as approximation
      // (no official Gemini tokenizer for Node.js)
      return new TiktokenTokenizer();
    default:
      // For any custom/unknown provider, use tiktoken as fallback
      return new TiktokenTokenizer();
  }
}
