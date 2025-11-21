import { encoding_for_model, get_encoding, type Tiktoken } from "tiktoken";
import { BaseTokenizer, type ProviderMessage } from "./base";

/**
 * Tiktoken-based tokenizer (OpenAI's tokenizer)
 * Used as the default/fallback tokenizer for all providers
 * Uses cl100k_base encoding (GPT-4, GPT-3.5-turbo)
 */
export class TiktokenTokenizer extends BaseTokenizer {
  private encoding: Tiktoken;

  constructor() {
    super();
    // cl100k_base is used by GPT-4, GPT-3.5-turbo, and is a good general approximation
    this.encoding = get_encoding("cl100k_base");
  }

  countMessageTokens(message: ProviderMessage): number {
    const text = this.extractTextFromMessage(message);

    // Also include role in token count for accuracy
    const roleText = message.role || "";
    const fullText = `${roleText}${text}`;

    const tokens = this.encoding.encode(fullText);
    return tokens.length;
  }

  /**
   * Free the encoding resources when done
   * Should be called when the tokenizer is no longer needed
   */
  free(): void {
    this.encoding.free();
  }

  /**
   * Get tokenizer for a specific OpenAI model
   * Falls back to cl100k_base if model is not recognized
   */
  static forModel(model: string): TiktokenTokenizer {
    try {
      const tokenizer = new TiktokenTokenizer();
      tokenizer.encoding.free();
      tokenizer.encoding = encoding_for_model(model as any);
      return tokenizer;
    } catch (error) {
      // Model not recognized, use default cl100k_base
      return new TiktokenTokenizer();
    }
  }
}
