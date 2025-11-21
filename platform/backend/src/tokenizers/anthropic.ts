import { countTokens } from "@anthropic-ai/tokenizer";
import { BaseTokenizer, type ProviderMessage } from "./base";

/**
 * Anthropic's official tokenizer
 *
 * NOTE: According to Anthropic's documentation, this tokenizer is accurate
 * for older models but provides only a rough approximation for Claude 3+ models.
 * For exact token counts, use the usage field in API responses.
 *
 * However, for optimization rules (which need relative comparison, not exact counts),
 * this approximation is sufficient.
 */
export class AnthropicTokenizer extends BaseTokenizer {
  countMessageTokens(message: ProviderMessage): number {
    const text = this.extractTextFromMessage(message);

    // Also include role in token count for accuracy
    const roleText = message.role || "";
    const fullText = `${roleText}${text}`;

    return countTokens(fullText);
  }
}
