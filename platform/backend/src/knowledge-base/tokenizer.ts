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
