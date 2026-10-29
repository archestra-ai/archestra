"use client";

import { act, renderHook } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorPagination } from "./use-cursor-pagination";
import { useDataTableQueryParams } from "./use-data-table-query-params";

vi.mock("next/navigation");

/** The page's URL: `router.push` writes it, `useSearchParams` reads it. */
let url = new URLSearchParams();

describe("useCursorPagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    url = new URLSearchParams();
    vi.mocked(usePathname).mockReturnValue("/llm/logs");
    vi.mocked(useSearchParams).mockImplementation(
      () => url as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useRouter).mockReturnValue({
      push: (href: string) => {
        url = new URLSearchParams(href.split("?")[1] ?? "");
      },
    } as unknown as ReturnType<typeof useRouter>);
  });

  it("keeps the page in the URL, so a reload lands on the same page", () => {
    const { result, rerender } = renderHook(() =>
      useCursorPagination({ defaultPageSize: 10 }),
    );

    act(() => result.current.tableState(page("cursor-2"))?.onOlder());
    rerender();
    act(() => result.current.tableState(page("cursor-3"))?.onOlder());
    rerender();

    expect(url.toString()).toBe("cursor=cursor-3&page=3");
    expect(result.current).toMatchObject({ cursor: "cursor-3", pageIndex: 2 });

    // A reload is a fresh mount on the same URL.
    const reloaded = renderHook(() =>
      useCursorPagination({ defaultPageSize: 10 }),
    );
    expect(reloaded.result.current).toMatchObject({
      cursor: "cursor-3",
      pageIndex: 2,
    });
  });

  it("steps newer one page at a time, then back to the newest", () => {
    const { result, rerender } = renderHook(() => useCursorPagination());

    act(() => result.current.tableState(page("cursor-2"))?.onOlder());
    rerender();
    act(() => result.current.tableState(page("cursor-3"))?.onOlder());
    rerender();

    act(() => result.current.tableState(page(null))?.onNewer());
    rerender();
    expect(result.current).toMatchObject({ cursor: "cursor-2", pageIndex: 1 });

    act(() => result.current.tableState(page(null))?.onNewer());
    rerender();
    expect(url.toString()).toBe("");
    expect(result.current.tableState(page(null))?.canGoNewer).toBe(false);
  });

  it("sends a shared link's Newer to the newest page", () => {
    url = new URLSearchParams("cursor=cursor-7&page=8");
    const { result, rerender } = renderHook(() => useCursorPagination());

    act(() => result.current.tableState(page(null))?.onNewer());
    rerender();

    expect(url.toString()).toBe("");
    expect(result.current.pageIndex).toBe(0);
  });

  it("starts over from the newest page when the page size changes", () => {
    url = new URLSearchParams("cursor=cursor-2&page=2");
    const { result, rerender } = renderHook(() =>
      useCursorPagination({ defaultPageSize: 10 }),
    );

    act(() => result.current.tableState(page(null))?.onPageSizeChange(50));
    rerender();

    expect(url.toString()).toBe("pageSize=50");
    expect(result.current).toMatchObject({
      cursor: undefined,
      pageIndex: 0,
      pageSize: 50,
    });
  });

  it("drops the page position when a filter changes", () => {
    url = new URLSearchParams("cursor=cursor-2&page=2&pageSize=50");
    const { result } = renderHook(() => useDataTableQueryParams());

    act(() => result.current.updateQueryParams({ userId: "user-1" }));

    expect(url.toString()).toBe("pageSize=50&userId=user-1");
  });
});

function page(nextCursor: string | null) {
  return { hasNext: nextCursor !== null, nextCursor };
}
