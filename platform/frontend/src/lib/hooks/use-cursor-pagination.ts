"use client";

import { useCallback, useState } from "react";
import { DEFAULT_TABLE_LIMIT } from "@/consts";

interface UseCursorPaginationOptions {
  defaultPageSize?: number;
}

export function useCursorPagination({
  defaultPageSize = DEFAULT_TABLE_LIMIT,
}: UseCursorPaginationOptions = {}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);

  const goOlder = useCallback(
    (nextCursor: string | null) => {
      if (!nextCursor) return;
      setCursorHistory((history) => [...history, cursor]);
      setCursor(nextCursor);
    },
    [cursor],
  );

  const goNewer = useCallback(() => {
    const previousCursor = cursorHistory.at(-1);
    if (previousCursor === undefined) return;
    setCursorHistory((history) => history.slice(0, -1));
    setCursor(previousCursor);
  }, [cursorHistory]);

  const goNewest = useCallback(() => {
    setCursorHistory([]);
    setCursor(null);
  }, []);

  const setPageSize = useCallback((nextPageSize: number) => {
    setPageSizeState(nextPageSize);
    setCursorHistory([]);
    setCursor(null);
  }, []);

  return {
    cursor: cursor ?? undefined,
    pageIndex: cursorHistory.length,
    pageSize,
    canGoNewer: cursorHistory.length > 0,
    goOlder,
    goNewer,
    goNewest,
    setPageSize,
  };
}
