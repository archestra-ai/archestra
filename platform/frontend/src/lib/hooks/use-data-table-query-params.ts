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
  const pageIndex = Math.max(
    0,
    Number.parseInt(activeSearchParams.get("page") || "1", 10) - 1,
  );
  const pageSize = Math.max(
    1,
    Number.parseInt(
      activeSearchParams.get("pageSize") || `${defaultPageSize}`,
      10,
    ),
  );
  const offset = pageIndex * pageSize;

  const updateQueryParams = useCallback(
    (updates: QueryParamUpdates) => {
      if (params?.queryParamsAdapter) {
        params.queryParamsAdapter.updateQueryParams(updates);
        return;
      }

      const nextParams = new URLSearchParams(searchParams.toString());
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
    setPagination,
  };
}
