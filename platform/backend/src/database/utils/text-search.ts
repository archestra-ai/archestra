import { and, type Column, ilike, or, type SQL } from "drizzle-orm";

/**
 * Upper bound on how many tokens a single search string contributes to the
 * generated `WHERE`. Each token adds one `ILIKE` per searched column, so an
 * unbounded query string would let a caller grow the plan without limit.
 * Extra tokens beyond the cap are ignored rather than rejected — the search
 * simply stays broader than the user typed.
 */
const MAX_SEARCH_TOKENS = 10;

/**
 * Build a case-insensitive filter matching rows where **every** whitespace-
 * separated token of `query` appears in **at least one** of `columns`.
 *
 * Matching the whole query as a single substring makes results depend on the
 * order and punctuation a value happens to be stored with: searching
 * `"Ada Lovelace"` misses a directory-synced `"Lovelace, Ada M."` even though
 * both tokens are present. Requiring each token independently keeps the search
 * order- and punctuation-insensitive while staying a conjunction, so adding
 * words still narrows the result set.
 *
 * Returns `undefined` when the query has no usable tokens, so callers can
 * spread the result into a filter list and get "no filter" for a blank search.
 */
export function buildTokenizedSearchFilter({
  query,
  columns,
}: {
  query: string | undefined | null;
  columns: Column[];
}): SQL | undefined {
  if (!query || columns.length === 0) {
    return undefined;
  }

  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

  const tokenFilters = tokens
    .slice(0, MAX_SEARCH_TOKENS)
    .map((token) => {
      const pattern = `%${escapeLikePattern(token)}%`;
      return or(...columns.map((column) => ilike(column, pattern)));
    })
    .filter((filter): filter is SQL => filter !== undefined);

  return and(...tokenFilters);
}

/**
 * Neutralize `LIKE` wildcards so a query containing `%` or `_` is matched
 * literally instead of silently widening the search. Backslash is Postgres'
 * default `LIKE` escape character, so escaping it alongside the wildcards
 * needs no explicit `ESCAPE` clause.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
