import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMyAgentExecution } from "./agent-background-execution.query";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getMyAgentExecution: vi.fn(),
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
