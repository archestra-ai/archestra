import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMyAgentRun, useMyAgentRuns } from "./agent-runtime.query";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getMyAgentRun: vi.fn(),
      getMyAgentRuns: vi.fn(),
    },
  };
});

const sdk = vi.mocked(archestraApiSdk);

describe("useMyAgentRun", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("stops polling after a run load exhausts its retries", async () => {
    vi.useFakeTimers();
    sdk.getMyAgentRun.mockResolvedValue({
      data: undefined,
      error: {
        error: {
          message: "Run not found",
          type: "api_not_found_error",
        },
      },
    } as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMyAgentRun("task-1"), {
      wrapper,
    });

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.isError).toBe(true);
    const callsAfterRetries = sdk.getMyAgentRun.mock.calls.length;

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(sdk.getMyAgentRun).toHaveBeenCalledTimes(callsAfterRetries);
  });
});

describe("useMyAgentRuns", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not poll a list whose runs are all finished", async () => {
    vi.useFakeTimers();
    sdk.getMyAgentRuns.mockResolvedValue({
      data: {
        data: [{ endedAt: "2026-09-03T12:00:00.000Z" }],
        pagination: {},
      },
      error: undefined,
    } as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useMyAgentRuns(), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sdk.getMyAgentRuns).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(sdk.getMyAgentRuns).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while any run is active", async () => {
    vi.useFakeTimers();
    sdk.getMyAgentRuns.mockResolvedValue({
      data: {
        data: [{ endedAt: null }],
        pagination: {},
      },
      error: undefined,
    } as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useMyAgentRuns(), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(sdk.getMyAgentRuns.mock.calls.length).toBeGreaterThan(1);
  });

  it("loads every bounded page so older runs remain searchable", async () => {
    sdk.getMyAgentRuns
      .mockResolvedValueOnce({
        data: {
          data: [{ taskId: "task-1", endedAt: "2026-09-03T12:00:00.000Z" }],
          pagination: { hasNext: true },
        },
        error: undefined,
      } as never)
      .mockResolvedValueOnce({
        data: {
          data: [{ taskId: "task-2", endedAt: "2026-09-03T12:01:00.000Z" }],
          pagination: { hasNext: false },
        },
        error: undefined,
      } as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMyAgentRuns(), { wrapper });

    await vi.waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(sdk.getMyAgentRuns).toHaveBeenNthCalledWith(1, {
      query: { limit: 100, offset: 0 },
    });
    expect(sdk.getMyAgentRuns).toHaveBeenNthCalledWith(2, {
      query: { limit: 100, offset: 100 },
    });
  });
});
