import { get_encoding, type Tiktoken } from "tiktoken";
import { BaseTokenizer } from "./base";

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

  protected computeMessageTokens(encodableText: string): number {
    // Ordinary encoding: treat reserved-marker literals (e.g. `<|endoftext|>`)
    // that appear in tool results as plain text. `encode()` raises on them by
    // default, which would crash counting on otherwise-valid content; the
    // native cl100k path (proxy-transform-core) counts ordinally too, so this
    // keeps the two byte-identical.
    return this.encoding.encode_ordinary(encodableText).length;
  }
}
