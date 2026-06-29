import { get_encoding, type Tiktoken } from "tiktoken";

let cachedEncoding: Tiktoken | null = null;

export function getEncoding(): Tiktoken {
  if (!cachedEncoding) {
    cachedEncoding = get_encoding("cl100k_base");
  }
  return cachedEncoding;
}

export function countTokens(encoding: Tiktoken, text: string): number {
  return encoding.encode(text).length;
}
