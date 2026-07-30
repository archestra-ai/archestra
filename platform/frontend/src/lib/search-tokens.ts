/**
 * Whether every whitespace-separated token of `query` appears in at least one
 * of `haystacks` (case-insensitive).
 *
 * Matching the query as one substring makes results depend on the order and
 * punctuation a value happens to be stored with: searching "Ada Lovelace"
 * misses a directory-synced "Lovelace, Ada M." even though both tokens are
 * present. Requiring each token independently keeps matching order- and
 * punctuation-insensitive while staying a conjunction, so typing more words
 * still narrows the list.
 *
 * Mirrors the server-side behaviour of `buildTokenizedSearchFilter` so a list
 * filtered in the browser and one filtered by the API agree.
 */
export function matchesSearchTokens(
  query: string,
  haystacks: Array<string | null | undefined>,
): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }

  const candidates = haystacks
    .filter((haystack): haystack is string => Boolean(haystack))
    .map((haystack) => haystack.toLowerCase());

  return tokens.every((token) =>
    candidates.some((candidate) => candidate.includes(token)),
  );
}
