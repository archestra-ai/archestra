import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useMyAgentExecution,
  useMyAgentExecutions,
} from "./agent-background-execution.query";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getMyAgentExecution: vi.fn(),
      getMyAgentExecutions: vi.fn(),
    },
  };
});

const sdk = vi.mocked(archestraApiSdk);

describe("useMyAgentExecution", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("stops polling after an execution load exhausts its retries", async () => {
    vi.useFakeTimers();
    sdk.getMyAgentExecution.mockResolvedValue({
      data: undefined,
      error: {
        error: {
          message: "Execution not found",
          type: "api_not_found_error",
        },
      },
    } as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMyAgentExecution("task-1"), {
      wrapper,
    });

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.isError).toBe(true);
    const callsAfterRetries = sdk.getMyAgentExecution.mock.calls.length;

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(sdk.getMyAgentExecution).toHaveBeenCalledTimes(callsAfterRetries);
  });
});

describe("useMyAgentExecutions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not poll a list whose executions are all finished", async () => {
    vi.useFakeTimers();
    sdk.getMyAgentExecutions.mockResolvedValue({
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
    renderHook(() => useMyAgentExecutions(), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sdk.getMyAgentExecutions).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(sdk.getMyAgentExecutions).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while any execution is active", async () => {
    vi.useFakeTimers();
    sdk.getMyAgentExecutions.mockResolvedValue({
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
    renderHook(() => useMyAgentExecutions(), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(sdk.getMyAgentExecutions.mock.calls.length).toBeGreaterThan(1);
  });

  it("loads every bounded page so older executions remain searchable", async () => {
    sdk.getMyAgentExecutions
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
    const { result } = renderHook(() => useMyAgentExecutions(), { wrapper });

    await vi.waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(sdk.getMyAgentExecutions).toHaveBeenNthCalledWith(1, {
      query: { limit: 100, offset: 0 },
    });
    expect(sdk.getMyAgentExecutions).toHaveBeenNthCalledWith(2, {
      query: { limit: 100, offset: 100 },
    });
  });
});
