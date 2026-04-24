/**
 * Canonical memory content normalization used for deterministic tombstone hashing.
 * This intentionally stays lightweight and deterministic for rollout-1.
 */
export function normalizeMemoryContent(content: string): string {
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
