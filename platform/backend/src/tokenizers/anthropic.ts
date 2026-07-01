import { countTokens } from "@anthropic-ai/tokenizer";
import { BaseTokenizer } from "./base";

/**
 * Anthropic's official tokenizer. Use for approximation before sending a request.
 * For exact token count, see token usage info in the LLM response.
 */
export class AnthropicTokenizer extends BaseTokenizer {
  protected computeMessageTokens(encodableText: string): number {
    return countTokens(encodableText);
  }
}
