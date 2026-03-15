"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { DEFAULT_TABLE_LIMIT } from "./utils";

type QueryParamUpdates = Record<string, string | null | undefined>;

export function useDataTableQueryParams(params?: { defaultPageSize?: number }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const defaultPageSize = params?.defaultPageSize ?? DEFAULT_TABLE_LIMIT;
  const pageIndex = Math.max(
    0,
    Number.parseInt(searchParams.get("page") || "1", 10) - 1,
  );
  const pageSize = Math.max(
    1,
    Number.parseInt(searchParams.get("pageSize") || `${defaultPageSize}`, 10),
  );
  const offset = pageIndex * pageSize;

  const updateQueryParams = useCallback(
    (updates: QueryParamUpdates) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === "") {
          nextParams.delete(key);
        } else {
          nextParams.set(key, value);
        }
      }
      router.push(`${pathname}?${nextParams.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
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
    searchParams,
    pathname,
    pageIndex,
    pageSize,
    offset,
    updateQueryParams,
    setPagination,
  };
}
