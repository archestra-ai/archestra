"use client";

import { act, renderHook } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataTableQueryParams } from "./use-data-table-query-params";

const mockPush = vi.fn();

vi.mock("next/navigation");

function setSearchParams(params: URLSearchParams) {
  vi.mocked(useSearchParams).mockReturnValue(
    params as unknown as ReturnType<typeof useSearchParams>,
  );
}

describe("useDataTableQueryParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/agents");
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
    } as unknown as ReturnType<typeof useRouter>);
    setSearchParams(new URLSearchParams());
  });

  it("returns default pagination values when query params are absent", () => {
    const { result } = renderHook(() => useDataTableQueryParams());

    expect(result.current.pageIndex).toBe(0);
    expect(result.current.pageSize).toBe(10);
    expect(result.current.offset).toBe(0);
  });

  it("parses page and pageSize from search params", () => {
    setSearchParams(new URLSearchParams("page=3&pageSize=25&search=models"));

    const { result } = renderHook(() => useDataTableQueryParams());

    expect(result.current.pageIndex).toBe(2);
    expect(result.current.pageSize).toBe(25);
    expect(result.current.offset).toBe(50);
    expect(result.current.searchParams.get("search")).toBe("models");
  });

  it("updates query params and removes empty values", () => {
    setSearchParams(new URLSearchParams("page=2&pageSize=10&search=agents"));

    const { result } = renderHook(() => useDataTableQueryParams());

    act(() => {
      result.current.updateQueryParams({
        search: "tools",
        page: "1",
        pageSize: "",
      });
    });

    expect(mockPush).toHaveBeenCalledWith("/agents?page=1&search=tools", {
      scroll: false,
    });
  });

  it("pushes the bare pathname when all query params are removed", () => {
    setSearchParams(new URLSearchParams("page=1&pageSize=10"));

    const { result } = renderHook(() => useDataTableQueryParams());

    act(() => {
      result.current.updateQueryParams({
        page: null,
        pageSize: undefined,
      });
    });

    expect(mockPush).toHaveBeenCalledWith("/agents", { scroll: false });
  });

  it("sets pagination using 1-indexed page values in the URL", () => {
    const { result } = renderHook(() => useDataTableQueryParams());

    act(() => {
      result.current.setPagination({ pageIndex: 2, pageSize: 50 });
    });

    expect(mockPush).toHaveBeenCalledWith("/agents?page=3&pageSize=50", {
      scroll: false,
    });
  });
});
