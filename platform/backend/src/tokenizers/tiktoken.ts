import { get_encoding, type Tiktoken } from "tiktoken";
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
    const text = this.getMessageText(message);
    const fullText = `${message.role || ""}${text}`;

    const tokens = this.encoding.encode(fullText);
    return tokens.length;
  }
}
