"use client";

import { archestraApiSdk } from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  type McpRegistryListQuery,
  type McpRegistryRow,
  mcpRegistryQueryKey,
} from "@/lib/mcp/mcp-registry.query";
import { throwOnApiError } from "@/lib/utils/api";

// A module of its own: the registry query module is imported by server
// components, and React's server build has no ref hooks.

/**
 * The registry rows of the given catalog items, in any number: one request per
 * hundred ids (the page limit). For pickers that show what a record already
 * uses, whose ids can be anywhere in the list.
 */
export function useMcpRegistryRowsByIds(
  ids: string[],
  options?: Pick<McpRegistryListQuery, "includeBuiltIn" | "includeApps">,
) {
  const sortedIds = [...new Set(ids)].sort();
  const idsKey = sortedIds.join(",");
  const chunks: string[][] = [];
  for (let i = 0; i < sortedIds.length; i += MAX_REGISTRY_PAGE_SIZE) {
    chunks.push(sortedIds.slice(i, i + MAX_REGISTRY_PAGE_SIZE));
  }
  const results = useQueries({
    queries: chunks.map((catalogIds) => ({
      queryKey: [...mcpRegistryQueryKey, "rows-by-id", catalogIds, options],
      queryFn: async () => {
        const { data, error } = await searchMcpRegistry({
          body: {
            ...options,
            catalogIds,
            sortBy: "name",
            sortDirection: "asc",
            limit: MAX_REGISTRY_PAGE_SIZE,
            offset: 0,
          },
        });
        throwOnApiError(error, { toastOnError: false });
        return data?.data ?? [];
      },
    })),
    combine: combineRowChunks,
  });

  // A changed id set is a new query with nothing to show, even for the ids
  // it shares with the previous set (`placeholderData` has no previous data
  // to give a new observer inside `useQueries`). Rows already known stay on
  // screen until their new chunk answers; a removed id leaves at once.
  const knownRows = useRef(new Map<string, McpRegistryRow>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: idsKey stands for sortedIds
  const data = useMemo(() => {
    const requested = new Set(sortedIds);
    const answered = new Set<string>();
    const rows: McpRegistryRow[] = [];
    results.chunks.forEach((chunk, i) => {
      if (!chunk.data) return;
      for (const id of chunks[i] ?? []) answered.add(id);
      for (const row of chunk.data) rows.push(row);
    });
    for (const [id, row] of knownRows.current) {
      if (requested.has(id) && !answered.has(id)) rows.push(row);
    }
    const next = new Map<string, McpRegistryRow>();
    for (const row of rows) next.set(row.id, row);
    knownRows.current = next;
    return rows;
  }, [results.chunks, idsKey]);
  // An empty id set has nothing to answer: a caller's ids are often empty
  // until its own source loads, so only a real set that answered counts.
  // A state latch set during render: React re-renders at once with it, and a
  // render it discards (StrictMode) leaves nothing behind.
  const [hasLoaded, setHasLoaded] = useState(false);
  if (!hasLoaded && sortedIds.length > 0 && !results.isPending) {
    setHasLoaded(true);
  }

  return {
    data,
    /** Some requested chunk has not answered yet. */
    isPending: results.isPending,
    /**
     * A non-empty id set has answered once: later id changes keep the known
     * rows, so a loading state should wait only for this. False while there
     * are no ids; a caller with none decides from the source of its ids.
     */
    hasLoaded,
    isError: results.isError,
    refetch: results.refetch,
  };
}

// ===== Internal =====

const { searchMcpRegistry } = archestraApiSdk;

/** The most rows one registry page request returns. */
const MAX_REGISTRY_PAGE_SIZE = 100;

/** Module-level, so `useQueries` can keep its combined result between renders. */
function combineRowChunks(
  results: Array<{
    data: McpRegistryRow[] | undefined;
    isPending: boolean;
    isError: boolean;
    refetch: () => Promise<unknown>;
  }>,
) {
  return {
    chunks: results.map((result) => ({ data: result.data })),
    isPending: results.some((result) => result.isPending),
    isError: results.some((result) => result.isError),
    refetch: () => Promise.all(results.map((result) => result.refetch())),
  };
}
