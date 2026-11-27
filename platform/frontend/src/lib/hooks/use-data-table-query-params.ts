"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import type {
  QueryParamsAdapter,
  QueryParamUpdates,
} from "@/lib/hooks/use-query-params-adapter";

/**
 * Use URL-backed table state for server-paginated or shareable table views.
 * Simple client-only filtering can stay in local component state when deep
 * linking is not valuable.
 */
export function useDataTableQueryParams(params?: {
  defaultPageSize?: number;
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const activeSearchParams =
    params?.queryParamsAdapter?.searchParams ?? searchParams;

  const defaultPageSize = params?.defaultPageSize ?? DEFAULT_TABLE_LIMIT;
  // A hand-edited `page=abc` parses to NaN, which `Math.max` would pass on.
  const pageIndex = Math.max(
    0,
    (Number.parseInt(activeSearchParams.get("page") || "1", 10) || 1) - 1,
  );
  const pageSize = Math.max(
    1,
    Number.parseInt(
      activeSearchParams.get("pageSize") || `${defaultPageSize}`,
      10,
    ) || defaultPageSize,
  );
  const offset = pageIndex * pageSize;

  const updateQueryParams = useCallback(
    (updates: QueryParamUpdates) => {
      if (params?.queryParamsAdapter) {
        params.queryParamsAdapter.updateQueryParams(updates);
        return;
      }

      const nextParams = new URLSearchParams(searchParams.toString());
      // A keyset cursor belongs to the listing it was issued for, so any
      // other change starts that listing over from the newest page.
      if (!("cursor" in updates) && nextParams.has("cursor")) {
        nextParams.delete("cursor");
        nextParams.delete("page");
      }
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === "") {
          nextParams.delete(key);
        } else {
          nextParams.set(key, value);
        }
      }
      const nextQueryString = nextParams.toString();
      router.push(
        nextQueryString ? `${pathname}?${nextQueryString}` : pathname,
        { scroll: false },
      );
    },
    [pathname, router, searchParams, params?.queryParamsAdapter],
  );

  /**
   * Write what narrows the listing (a search, a filter, a sort) and return to
   * its first page: that is where the first matches are, and the page the
   * reader was on may not exist in the narrowed listing. Filter controls
   * write through this, so no table has to remember the reset.
   * `updateQueryParams` stays for URL state that leaves the rows alone, such
   * as which row is open.
   */
  const setFilters = useCallback(
    (updates: QueryParamUpdates) =>
      updateQueryParams({ ...updates, page: null }),
    [updateQueryParams],
  );

  const setPagination = useCallback(
    (pagination: { pageIndex: number; pageSize: number }) => {
      updateQueryParams({
        page: String(pagination.pageIndex + 1),
        pageSize: String(pagination.pageSize),
      });
    },
    [updateQueryParams],
  );

  return {
    searchParams: activeSearchParams,
    pathname,
    pageIndex,
    pageSize,
    offset,
    updateQueryParams,
    setFilters,
    setPagination,
  };
}
