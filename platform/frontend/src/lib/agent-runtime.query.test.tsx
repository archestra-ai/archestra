import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runtimePreflightDisabledReason,
  useMyAgentRun,
  useMyAgentRuns,
} from "./agent-runtime.query";

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

  it("polls retained idle workspaces slowly, accelerates during resume, and stops after deletion", async () => {
    vi.useFakeTimers();
    const response = (state: string) =>
      ({
        data: {
          endedAt: "2026-09-03T12:00:00.000Z",
          workspace: { state },
        },
        error: undefined,
      }) as never;
    sdk.getMyAgentRun.mockResolvedValue(response("idle"));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { unmount } = renderHook(() => useMyAgentRun("task-1"), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(sdk.getMyAgentRun).toHaveBeenCalledTimes(1);
    sdk.getMyAgentRun.mockResolvedValue(response("resuming"));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(sdk.getMyAgentRun).toHaveBeenCalledTimes(2);
    sdk.getMyAgentRun.mockResolvedValue(response("deleted"));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(sdk.getMyAgentRun).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(sdk.getMyAgentRun).toHaveBeenCalledTimes(3);
    unmount();
    queryClient.clear();
  });

  it("refreshes the sidebar list when the session's current turn moves, not on the first read", async () => {
    vi.useFakeTimers();
    const response = (turn: {
      taskId: string;
      state: string;
      endedAt: string | null;
    }) => ({ data: { ...turn, workspace: null }, error: undefined }) as never;
    const working = {
      taskId: "task-1",
      state: "TASK_STATE_WORKING",
      endedAt: null,
    };
    sdk.getMyAgentRun.mockResolvedValue(response(working));
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { unmount } = renderHook(() => useMyAgentRun("session-1"), {
      wrapper,
    });

    // The first read is not a change: invalidating the lists here used to
    // cancel and restart their page loads on every run page.
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sdk.getMyAgentRun).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(invalidate).not.toHaveBeenCalled();
    sdk.getMyAgentRun.mockResolvedValue(
      response({ ...working, taskId: "task-2" }),
    );
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenLastCalledWith({
      queryKey: ["agent-runs", "mine"],
    });
    unmount();
    queryClient.clear();
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

  it("polls the loaded active page without walking older history", async () => {
    vi.useFakeTimers();
    sdk.getMyAgentRuns.mockImplementation(
      async ({ query } = {}) =>
        ({
          data: {
            data: [{ endedAt: null }],
            pagination: { hasNext: !query?.offset },
          },
          error: undefined,
        }) as never,
    );
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useMyAgentRuns(), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sdk.getMyAgentRuns).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(sdk.getMyAgentRuns).toHaveBeenCalledTimes(2);
    expect(
      sdk.getMyAgentRuns.mock.calls.every(
        ([options]) => options?.query?.offset === 0,
      ),
    ).toBe(true);
  });

  it("publishes the first bounded page before older runs are requested", async () => {
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

    await vi.waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(true);
    expect(sdk.getMyAgentRuns).toHaveBeenCalledTimes(1);
    await act(() => result.current.fetchNextPage());
    await vi.waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(sdk.getMyAgentRuns).toHaveBeenNthCalledWith(1, {
      query: { limit: 20, offset: 0, sort: "recent" },
    });
    expect(sdk.getMyAgentRuns).toHaveBeenNthCalledWith(2, {
      query: { limit: 20, offset: 20, sort: "recent" },
    });
  });
});

describe("runtimePreflightDisabledReason", () => {
  it("names why Send is off for each preflight outcome", () => {
    expect(
      runtimePreflightDisabledReason({ isPending: false, isError: true }),
    ).toBe("Can't check this agent's setup");
    expect(
      runtimePreflightDisabledReason({
        isPending: false,
        data: { ready: false, missing: [{ adminOnly: true }] },
      }),
    ).toBe("Only admins can run this agent");
    expect(
      runtimePreflightDisabledReason({
        isPending: false,
        data: { ready: false, missing: [{}] },
      }),
    ).toBe("Connect the credentials this agent needs");
    expect(
      runtimePreflightDisabledReason({
        isPending: false,
        data: { ready: true, missing: [] },
      }),
    ).toBeUndefined();
  });
});
