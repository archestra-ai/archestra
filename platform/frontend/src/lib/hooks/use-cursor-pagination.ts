"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import type { CursorPaginationState } from "@/components/ui/data-table-pagination";
import { DEFAULT_TABLE_LIMIT } from "@/consts";

interface UseCursorPaginationOptions {
  defaultPageSize?: number;
}

/**
 * Keyset pagination kept in the URL (`cursor`, `page`, `pageSize`), so a
 * reload, the back button and a shared link all land on the same page.
 *
 * The API only walks older, so "Newer" needs the cursor of the page before.
 * Each step remembers it in session storage; a shared link that arrives
 * mid-list has no such memory, and its "Newer" returns to the newest page.
 *
 * Changing a filter must drop `cursor` and `page`: a cursor belongs to the
 * listing it was issued for. The URL helpers (`useDataTableQueryParams` and
 * the pages' own) drop them with any update that sets no cursor.
 *
 * Hand `tableState(response.pagination)` to `DataTable`'s `cursorPagination`;
 * it wires the footer's Newer/Older and page size to the URL.
 */
export function useCursorPagination({
  defaultPageSize = DEFAULT_TABLE_LIMIT,
}: UseCursorPaginationOptions = {}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const cursor = searchParams.get("cursor") || null;
  const pageIndex = cursor
    ? Math.max(1, Number.parseInt(searchParams.get("page") || "2", 10) - 1)
    : 0;
  const pageSize = Math.max(
    1,
    Number.parseInt(searchParams.get("pageSize") || `${defaultPageSize}`, 10) ||
      defaultPageSize,
  );

  const navigate = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.push(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  const goOlder = useCallback(
    (nextCursor: string | null) => {
      if (!nextCursor) return;
      rememberPreviousCursor(nextCursor, cursor);
      navigate({ cursor: nextCursor, page: String(pageIndex + 2) });
    },
    [cursor, navigate, pageIndex],
  );

  const goNewest = useCallback(() => {
    if (!cursor) return;
    navigate({ cursor: null, page: null });
  }, [cursor, navigate]);

  const goNewer = useCallback(() => {
    if (!cursor) return;
    const previous = recallPreviousCursor(cursor);
    if (!previous || pageIndex <= 1) {
      navigate({ cursor: null, page: null });
      return;
    }
    navigate({ cursor: previous, page: String(pageIndex) });
  }, [cursor, navigate, pageIndex]);

  const setPageSize = useCallback(
    (nextPageSize: number) => {
      navigate({
        pageSize:
          nextPageSize === defaultPageSize ? null : String(nextPageSize),
        cursor: null,
        page: null,
      });
    },
    [defaultPageSize, navigate],
  );

  const tableState = useCallback(
    (
      page: { hasNext: boolean; nextCursor: string | null } | null | undefined,
    ): CursorPaginationState | undefined =>
      page
        ? {
            pageIndex,
            pageSize,
            hasNext: page.hasNext,
            canGoNewer: cursor !== null,
            onPageSizeChange: setPageSize,
            onNewer: goNewer,
            onOlder: () => goOlder(page.nextCursor),
          }
        : undefined,
    [cursor, goNewer, goOlder, pageIndex, pageSize, setPageSize],
  );

  return {
    cursor: cursor ?? undefined,
    pageIndex,
    pageSize,
    goNewest,
    tableState,
  };
}

// ===

function rememberPreviousCursor(cursor: string, previous: string | null) {
  try {
    window.sessionStorage.setItem(storageKey(cursor), previous ?? "");
  } catch {
    // Without storage, "Newer" falls back to the newest page.
  }
}

function recallPreviousCursor(cursor: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(cursor)) || null;
  } catch {
    return null;
  }
}

function storageKey(cursor: string) {
  return `archestra-cursor-prev:${cursor}`;
}
