"use client";

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCursorPagination } from "./use-cursor-pagination";

describe("useCursorPagination", () => {
  it("walks older with a cursor stack and returns newer without URL state", () => {
    const { result } = renderHook(() =>
      useCursorPagination({ defaultPageSize: 10 }),
    );

    act(() => result.current.goOlder("cursor-2"));
    expect(result.current).toMatchObject({
      cursor: "cursor-2",
      pageIndex: 1,
      canGoNewer: true,
    });

    act(() => result.current.goOlder("cursor-3"));
    expect(result.current).toMatchObject({
      cursor: "cursor-3",
      pageIndex: 2,
    });

    act(() => result.current.goNewer());
    expect(result.current).toMatchObject({
      cursor: "cursor-2",
      pageIndex: 1,
    });

    act(() => result.current.goNewer());
    expect(result.current.cursor).toBeUndefined();
    expect(result.current.pageIndex).toBe(0);
    expect(result.current.canGoNewer).toBe(false);
  });

  it("resets the cursor stack when the page size changes", () => {
    const { result } = renderHook(() => useCursorPagination());

    act(() => result.current.goOlder("cursor-2"));
    act(() => result.current.setPageSize(50));

    expect(result.current).toMatchObject({
      cursor: undefined,
      pageIndex: 0,
      pageSize: 50,
      canGoNewer: false,
    });
  });
});
