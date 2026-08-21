import { useQuery } from "@tanstack/react-query";

/**
 * Every row matching a list query, not just the page in view — what backs a
 * table's "select all N that match this search query".
 *
 * `PaginationQuerySchema` caps a page at 100 across the API, so this walks the
 * offsets rather than asking for the lot in one request. It stops at `max`,
 * which callers set to the largest batch their bulk action can actually carry:
 * collecting more would only build a selection the action must refuse.
 *
 * Pass `enabled` so the walk happens on escalation rather than on every render
 * of a table nobody has selected anything in.
 */
export function useAllMatching<T>({
  queryKey,
  fetchPage,
  max = DEFAULT_MAX_ROWS,
  enabled = true,
}: {
  queryKey: unknown[];
  fetchPage: (page: { limit: number; offset: number }) => Promise<T[]>;
  max?: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey,
    enabled,
    queryFn: async () => {
      const collected: T[] = [];

      for (let offset = 0; offset < max; offset += ALL_MATCHING_PAGE_SIZE) {
        const page = await fetchPage({
          limit: ALL_MATCHING_PAGE_SIZE,
          offset,
        });
        collected.push(...page);

        // A short page is the last page; asking for the next one would only
        // cost a request to be told the same thing.
        if (page.length < ALL_MATCHING_PAGE_SIZE) break;
      }

      return collected.slice(0, max);
    },
  });
}

/** The API's per-page ceiling, so the walk takes as few requests as it can. */
export const ALL_MATCHING_PAGE_SIZE = 100;

/**
 * Ceiling for resources whose bulk action has no stated limit of its own. Ten
 * requests is already a lot to spend on a click, and a selection past this is
 * better served by narrowing the filters than by a longer walk.
 */
const DEFAULT_MAX_ROWS = 1000;
