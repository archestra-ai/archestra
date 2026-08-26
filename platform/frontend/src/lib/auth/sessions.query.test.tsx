import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBulkRevokeSessions } from "./sessions.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: { bulkRevokeSessions: vi.fn() },
}));

describe("useBulkRevokeSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the selected IDs in one generated-client request", async () => {
    vi.mocked(archestraApiSdk.bulkRevokeSessions).mockResolvedValue({
      data: {
        succeeded: [{ id: "session-one", name: "session-one" }],
        failed: [
          {
            id: "session-current",
            name: "session-current",
            error: "Current session cannot be revoked",
          },
        ],
      },
      error: undefined,
    } as never);

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useBulkRevokeSessions(), { wrapper });

    let outcome: Awaited<ReturnType<typeof result.current.mutateAsync>> | null =
      null;
    await act(async () => {
      outcome = await result.current.mutateAsync([
        { id: "session-one" },
        { id: "session-current" },
      ]);
    });

    expect(archestraApiSdk.bulkRevokeSessions).toHaveBeenCalledTimes(1);
    expect(archestraApiSdk.bulkRevokeSessions).toHaveBeenCalledWith({
      body: { ids: ["session-one", "session-current"] },
    });
    expect(outcome).toEqual({
      succeeded: ["session-one"],
      failed: [
        {
          label: "session-current",
          error: "Current session cannot be revoked",
        },
      ],
      affected: undefined,
    });
  });
});
