import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpToolCalls } from "./mcp-tool-call.query";

vi.mock("@archestra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared")>()),
  archestraApiSdk: { getMcpToolCall: vi.fn(), getMcpToolCalls: vi.fn() },
}));

const sdk = vi.mocked(archestraApiSdk);

type ToolCallsPage = archestraApiTypes.GetMcpToolCallsResponses["200"];

const unfilteredPage = {
  data: [{ id: "unfiltered" }],
  pagination: { limit: 10, nextCursor: null, hasNext: false },
} as unknown as ToolCallsPage;

const filteredPage = {
  data: [],
  pagination: { limit: 10, nextCursor: null, hasNext: false },
} as unknown as ToolCallsPage;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useMcpToolCalls", () => {
  beforeEach(() => {
    sdk.getMcpToolCalls.mockReset();
  });

  it("fetches the user's calls instead of showing the unfiltered first page", async () => {
    sdk.getMcpToolCalls.mockResolvedValue({
      data: filteredPage,
    } as Awaited<ReturnType<typeof sdk.getMcpToolCalls>>);

    const { result } = renderHook(
      () =>
        useMcpToolCalls({
          userId: "user-1",
          limit: 10,
          initialData: unfilteredPage,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual(filteredPage));
    expect(sdk.getMcpToolCalls).toHaveBeenCalledWith({
      query: { userId: "user-1", limit: 10 },
    });
  });
});
