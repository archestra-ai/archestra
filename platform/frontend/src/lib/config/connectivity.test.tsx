import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetHealth } = vi.hoisted(() => ({ mockGetHealth: vi.fn() }));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getHealth: (...args: unknown[]) => mockGetHealth(...args),
    },
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ConnectivityProvider, useConnectivity } from "./connectivity";

const HEALTH_OK = { data: { name: "archestra", status: "ok", version: "1" } };
const HEALTH_FAIL = { error: new Error("offline") };

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ConnectivityProvider>{children}</ConnectivityProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

// Settle pending fetches/effects. Driving polls explicitly via retry() keeps
// the test deterministic — TanStack's background refetchInterval is gated on
// tab focus/visibility, which is unreliable under jsdom + fake timers.
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe("ConnectivityProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("needs two consecutive /health failures before reporting backend-unreachable", async () => {
    mockGetHealth.mockResolvedValue(HEALTH_FAIL);
    const { result } = renderHook(() => useConnectivity(), {
      wrapper: makeWrapper().wrapper,
    });

    // Mount poll = failure #1 — still online under the hysteresis threshold.
    await flush();
    expect(result.current.state.kind).toBe("online");
    expect(mockGetHealth).toHaveBeenCalledTimes(1);

    // Next poll = failure #2 — now unreachable.
    act(() => result.current.retry());
    await flush();
    expect(result.current.state.kind).toBe("backend-unreachable");
    expect(mockGetHealth).toHaveBeenCalledTimes(2);
  });

  it("clears unreachable and fires exactly one refetch wave when /health recovers", async () => {
    mockGetHealth.mockResolvedValue(HEALTH_FAIL);
    const { queryClient, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useConnectivity(), { wrapper });

    await flush();
    act(() => result.current.retry());
    await flush();
    expect(result.current.state.kind).toBe("backend-unreachable");

    mockGetHealth.mockResolvedValue(HEALTH_OK);
    act(() => result.current.retry());
    await flush();
    expect(result.current.state.kind).toBe("online");

    const activeInvalidations = invalidateSpy.mock.calls.filter(
      ([arg]) => (arg as { type?: string } | undefined)?.type === "active",
    );
    expect(activeInvalidations).toHaveLength(1);
  });

  it("reports browser-offline immediately when navigator goes offline, independent of /health", async () => {
    mockGetHealth.mockResolvedValue(HEALTH_OK);
    const { result } = renderHook(() => useConnectivity(), {
      wrapper: makeWrapper().wrapper,
    });

    await flush();
    expect(result.current.state.kind).toBe("online");

    const onLineSpy = vi
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.state.kind).toBe("browser-offline");

    onLineSpy.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(result.current.state.kind).toBe("online");
  });

  it("fires exactly one refetch wave per offline→online transition, not while steady", async () => {
    mockGetHealth.mockResolvedValue(HEALTH_OK);
    const { queryClient, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useConnectivity(), { wrapper });
    await flush();

    const onLineSpy = vi.spyOn(navigator, "onLine", "get");
    const countActiveWaves = () =>
      invalidateSpy.mock.calls.filter(
        ([arg]) => (arg as { type?: string } | undefined)?.type === "active",
      ).length;

    for (let cycle = 1; cycle <= 2; cycle++) {
      onLineSpy.mockReturnValue(false);
      await act(async () => window.dispatchEvent(new Event("offline")));
      onLineSpy.mockReturnValue(true);
      await act(async () => window.dispatchEvent(new Event("online")));
      await flush();
      expect(result.current.state.kind).toBe("online");
      // One wave per recovery, and none from the steady-online renders between.
      expect(countActiveWaves()).toBe(cycle);
    }
  });
});
