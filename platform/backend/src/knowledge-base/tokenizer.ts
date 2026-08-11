import { get_encoding, type Tiktoken } from "tiktoken";

let cachedEncoding: Tiktoken | null = null;

export function getEncoding(): Tiktoken {
  if (!cachedEncoding) {
    cachedEncoding = get_encoding("cl100k_base");
  }
  return cachedEncoding;
}

export function countTokens(encoding: Tiktoken, text: string): number {
  return encodeText(encoding, text).length;
}

/**
 * Encode arbitrary user content. tiktoken's bare `encode(text)` THROWS when
 * the text contains a special-token literal (a GitHub issue quoting
 * "<|endoftext|>" failed ingestion this way); passing an empty
 * disallowed-special set encodes such literals as ordinary text instead.
 */
export function encodeText(encoding: Tiktoken, text: string): Uint32Array {
  return encoding.encode(text, undefined, []);
}

/**
 * Truncate `text` to at most `maxTokens` tokens, returning it unchanged when
 * it already fits. cl100k is a byte-level BPE, so a token boundary can split a
 * multi-byte character — the decoded prefix is cleaned of the trailing
 * replacement character that such a split produces.
 */
export function truncateToTokens(
  encoding: Tiktoken,
  text: string,
  maxTokens: number,
): string {
  if (maxTokens <= 0) {
    return "";
  }
  const tokens = encodeText(encoding, text);
  if (tokens.length <= maxTokens) {
    return text;
  }
  const bytes = encoding.decode(tokens.slice(0, maxTokens));
  return new TextDecoder("utf-8").decode(bytes).replace(/�+$/, "");
}
