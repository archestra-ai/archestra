"use client";

import { render, renderHook, waitFor } from "@testing-library/react";
import { usePathname, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListReturnUrlTracker, useListReturnHref } from "./use-list-return-url";

vi.mock("next/navigation");

function setLocation(pathname: string, query: string) {
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("ListReturnUrlTracker", () => {
  it("remembers the query string a list page was last visited with", () => {
    setLocation("/agents", "search=foo&page=2");
    render(<ListReturnUrlTracker />);

    expect(window.sessionStorage.getItem("archestra.list-return:/agents")).toBe(
      "search=foo&page=2",
    );
  });

  it("overwrites a stale entry once filters are cleared, so it cannot leak into a later visit", () => {
    window.sessionStorage.setItem(
      "archestra.list-return:/agents",
      "search=foo",
    );
    setLocation("/agents", "");
    render(<ListReturnUrlTracker />);

    expect(window.sessionStorage.getItem("archestra.list-return:/agents")).toBe(
      "",
    );
  });

  it("keys entries by exact pathname, so an unrelated page never sees another page's filters", () => {
    setLocation("/agents", "search=foo");
    const { rerender } = render(<ListReturnUrlTracker />);

    setLocation("/skills", "search=bar");
    rerender(<ListReturnUrlTracker />);

    expect(window.sessionStorage.getItem("archestra.list-return:/agents")).toBe(
      "search=foo",
    );
    expect(window.sessionStorage.getItem("archestra.list-return:/skills")).toBe(
      "search=bar",
    );
  });
});

describe("useListReturnHref", () => {
  it("enriches a bare href with the query string that pathname was last visited with", async () => {
    window.sessionStorage.setItem(
      "archestra.list-return:/agents",
      "search=foo&page=2",
    );

    const { result } = renderHook(() => useListReturnHref("/agents"));

    await waitFor(() =>
      expect(result.current).toBe("/agents?search=foo&page=2"),
    );
  });

  it("falls back to the plain href when that pathname was never visited this session", async () => {
    const { result } = renderHook(() => useListReturnHref("/agents"));

    await waitFor(() => expect(result.current).toBe("/agents"));
  });

  it("does not enrich an href that already carries its own query string", async () => {
    window.sessionStorage.setItem(
      "archestra.list-return:/agents",
      "search=foo",
    );

    const { result } = renderHook(() =>
      useListReturnHref("/agents?tab=advanced"),
    );

    await waitFor(() => expect(result.current).toBe("/agents?tab=advanced"));
  });

  it("re-resolves when the href changes to a different pathname", async () => {
    window.sessionStorage.setItem("archestra.list-return:/skills", "page=3");

    const { result, rerender } = renderHook(
      ({ href }) => useListReturnHref(href),
      { initialProps: { href: "/agents" } },
    );
    await waitFor(() => expect(result.current).toBe("/agents"));

    rerender({ href: "/skills" });
    await waitFor(() => expect(result.current).toBe("/skills?page=3"));
  });

  it("falls back to the plain href when storage access throws", async () => {
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("Storage disabled");
      });
    try {
      const { result } = renderHook(() => useListReturnHref("/agents"));
      await waitFor(() => expect(result.current).toBe("/agents"));
    } finally {
      get.mockRestore();
    }
  });
});
