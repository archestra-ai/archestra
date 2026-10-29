import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDocumentSeedFresh,
  markShellSeeded,
  useShellReady,
} from "./shell-deferral";

describe("useShellReady", () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds while the first requests fetch and releases once they settle", async () => {
    const { result } = renderHook(() => useShellReady(), { wrapper });
    let finish = () => {};
    const pageData = client.fetchQuery({
      queryKey: ["page-data"],
      queryFn: () =>
        new Promise<number>((resolve) => (finish = () => resolve(1))),
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current).toBe(false);

    finish();
    await act(async () => {
      await pageData;
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(result.current).toBe(true);
  });

  it("releases after the fallback when nothing fetches, and stays released", async () => {
    const { result, rerender } = renderHook(() => useShellReady(), {
      wrapper,
    });
    await act(() => vi.advanceTimersByTimeAsync(1400));
    expect(result.current).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current).toBe(true);

    // Later fetches (a client-side navigation) never hold the shell again.
    void client.fetchQuery({
      queryKey: ["next-page"],
      queryFn: () => new Promise<number>(() => {}),
    });
    await act(() => vi.advanceTimersByTimeAsync(10));
    rerender();
    expect(result.current).toBe(true);
  });

  it("does not release while the cache is idle before the first fetch", async () => {
    const { result } = renderHook(() => useShellReady(), { wrapper });
    client.setQueryData(["cached"], 1);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current).toBe(false);
  });

  it("releases a server-seeded page once its cache is idle, without waiting for the fallback", async () => {
    markShellSeeded(client);
    const { result } = renderHook(() => useShellReady(), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(result.current).toBe(true);
  });

  it("holds a server-seeded page while a request the page started is still fetching", async () => {
    markShellSeeded(client);
    let finish = () => {};
    const pageData = client.fetchQuery({
      queryKey: ["page-data"],
      queryFn: () =>
        new Promise<number>((resolve) => (finish = () => resolve(1))),
    });
    const { result } = renderHook(() => useShellReady(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(result.current).toBe(false);

    finish();
    await act(async () => {
      await pageData;
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(result.current).toBe(true);
  });
});

describe("isDocumentSeedFresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const KEY = ["organization", "details"];
  const query = (client: QueryClient) =>
    client.getQueryCache().find({ queryKey: KEY });

  it("counts a value the server seeded for this document as the page's read", () => {
    const client = new QueryClient();
    markShellSeeded(client);
    client.setQueryData(KEY, { name: "Org" });

    expect(isDocumentSeedFresh(client, query(client))).toBe(true);
  });

  it("does not count data in a page the server did not seed", () => {
    const client = new QueryClient();
    client.setQueryData(KEY, { name: "Org" });

    expect(isDocumentSeedFresh(client, query(client))).toBe(false);
  });

  it("stops counting once a read replaces the seed, or the page load is old", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    markShellSeeded(client);
    client.setQueryData(KEY, { name: "Org" });
    await client.fetchQuery({
      queryKey: KEY,
      queryFn: async () => ({ name: "Refreshed" }),
      staleTime: 0,
    });
    expect(isDocumentSeedFresh(client, query(client))).toBe(false);

    const later = new QueryClient();
    markShellSeeded(later);
    later.setQueryData(KEY, { name: "Org" });
    vi.advanceTimersByTime(31_000);
    expect(isDocumentSeedFresh(later, query(later))).toBe(false);
  });
});
