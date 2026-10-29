/**
 * Neutralize `LIKE` wildcards so a query containing `%` or `_` is matched
 * literally instead of silently widening the search. Backslash is Postgres'
 * default `LIKE` escape character, so escaping it alongside the wildcards
 * needs no explicit `ESCAPE` clause.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}
