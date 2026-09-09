import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useIsAppLoading, useReportSearchInFlight } from "./use-is-app-loading";

/**
 * The sidebar toggle's spinner is the app's only "I am loading" indicator, and
 * a search now reports its own wait twice over — a lit search box above a table
 * drawing a progress bar. These pin the rule that keeps the two apart: the
 * spinner still covers boot and page transitions, and sits out searches.
 */
describe("useIsAppLoading", () => {
  // Built per test, but stable across renders: a wrapper that constructs its
  // client inline hands every re-render a fresh cache, so nothing is ever
  // observed mid-fetch.
  function makeWrapper() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
    };
  }

  /** A query that never settles, standing in for a page still fetching. */
  function usePendingPageLoad(enabled: boolean) {
    useQuery({
      queryKey: ["page-data"],
      queryFn: () => new Promise<string>(() => {}),
      enabled,
    });
  }

  it("reports loading while a page has nothing to show yet", async () => {
    const { result } = renderHook(
      () => {
        usePendingPageLoad(true);
        return useIsAppLoading();
      },
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("does not update the shell while another component adds a query during render", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    function LoadingIndicator() {
      useIsAppLoading();
      return null;
    }

    function PageQuery({ enabled }: { enabled: boolean }) {
      if (enabled && !client.getQueryState(["render-started-query"])) {
        void client
          .fetchQuery({
            queryKey: ["render-started-query"],
            queryFn: () => new Promise<string>(() => {}),
          })
          .catch(() => undefined);
      }
      return null;
    }

    function TestTree({ showPage }: { showPage: boolean }) {
      return (
        <QueryClientProvider client={client}>
          <LoadingIndicator />
          <PageQuery enabled={showPage} />
        </QueryClientProvider>
      );
    }

    const view = render(<TestTree showPage={false} />);
    try {
      view.rerender(<TestTree showPage />);

      expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
        "Cannot update a component",
      );
    } finally {
      consoleError.mockRestore();
      view.unmount();
      client.clear();
    }
  });

  it("does not reschedule the shell when the pending count changes but loading does not", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    let finishFirst!: (value: string) => void;
    let finishSecond!: (value: string) => void;
    const first = client.fetchQuery({
      queryKey: ["first"],
      queryFn: () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    });
    const second = client.fetchQuery({
      queryKey: ["second"],
      queryFn: () =>
        new Promise<string>((resolve) => {
          finishSecond = resolve;
        }),
    });
    let renders = 0;
    const { result, unmount } = renderHook(
      () => {
        renders += 1;
        return useIsAppLoading();
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );

    try {
      expect(result.current).toBe(true);
      const loadingRenders = renders;
      await act(async () => {
        finishFirst("loaded");
        await first;
        await vi.runOnlyPendingTimersAsync();
      });
      expect(result.current).toBe(true);
      // Count-only updates caused a render/observer-notification feedback loop
      // during the cold permission load after impersonation.
      expect(renders).toBe(loadingRenders);

      await act(async () => {
        finishSecond("loaded");
        await second;
        await vi.runOnlyPendingTimersAsync();
      });
      expect(result.current).toBe(false);
    } finally {
      unmount();
      client.clear();
      vi.useRealTimers();
    }
  });

  it("stays quiet while a search is waiting, then covers the app again", async () => {
    const { result, rerender } = renderHook(
      ({ searching }: { searching: boolean }) => {
        usePendingPageLoad(true);
        useReportSearchInFlight(searching);
        return useIsAppLoading();
      },
      { wrapper: makeWrapper(), initialProps: { searching: true } },
    );

    // The fetch is genuinely out — it is the third indicator that is unwanted,
    // not the loading state itself.
    await waitFor(() => expect(result.current).toBe(false));

    rerender({ searching: false });

    // And the suppression lifts, rather than sticking for the session.
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("waits for every search box, not just the first one to finish", async () => {
    const { result, rerender } = renderHook(
      ({ first, second }: { first: boolean; second: boolean }) => {
        usePendingPageLoad(true);
        useReportSearchInFlight(first);
        useReportSearchInFlight(second);
        return useIsAppLoading();
      },
      { wrapper: makeWrapper(), initialProps: { first: true, second: true } },
    );

    await waitFor(() => expect(result.current).toBe(false));

    // One of two overlapping searches finishing must not speak for the other.
    await act(async () => {
      rerender({ first: false, second: true });
    });
    expect(result.current).toBe(false);

    rerender({ first: false, second: false });
    await waitFor(() => expect(result.current).toBe(true));
  });
});
