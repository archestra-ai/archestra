import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellDeferred } from "./shell-deferral";

describe("useShellDeferred", () => {
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
    const { result } = renderHook(() => useShellDeferred(), { wrapper });
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
    const { result, rerender } = renderHook(() => useShellDeferred(), {
      wrapper,
    });
    await act(() => vi.advanceTimersByTimeAsync(1400));
    expect(result.current).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current).toBe(true);

    // Later fetches (a client-side navigation) never hold the shell again.
    const later = client.fetchQuery({
      queryKey: ["next-page"],
      queryFn: () => new Promise<number>(() => {}),
    });
    void later;
    await act(() => vi.advanceTimersByTimeAsync(10));
    rerender();
    expect(result.current).toBe(true);
  });

  it("does not release on the fallback-free idle moment before anything fetched", async () => {
    const { result } = renderHook(() => useShellDeferred(), { wrapper });
    client.setQueryData(["cached"], 1);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current).toBe(false);
  });
});
