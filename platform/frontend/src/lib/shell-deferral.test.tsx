import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markShellSeeded, useShellReady } from "./shell-deferral";

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
