import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetConnectors = vi.fn();
const mockGetKnowledgeBases = vi.fn();

vi.mock("@archestra/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@archestra/shared")>(
      "@archestra/shared",
    );
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getConnectors: (...args: unknown[]) => mockGetConnectors(...args),
      getKnowledgeBases: (...args: unknown[]) => mockGetKnowledgeBases(...args),
    },
  };
});

import { useConnectorsByIds } from "./connector.query";
import { useKnowledgeBasesByIds } from "./knowledge-base.query";

type Query = { query: { ids: string[] } };

function rowsFor(lastSyncStatus: (id: string) => string) {
  return async ({ query }: Query) => ({
    data: {
      data: query.ids.map((id) => ({ id, lastSyncStatus: lastSyncStatus(id) })),
    },
    error: undefined,
  });
}

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const ids = (count: number, prefix: string) =>
  Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(i).padStart(3, "0")}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading knowledge sources by id", () => {
  it("reads every requested knowledge base, past the list's 100-row page, without the agent lists", async () => {
    mockGetKnowledgeBases.mockImplementation(rowsFor(() => "success"));
    const wanted = ids(300, "kb");

    const { result } = renderHook(() => useKnowledgeBasesByIds(wanted), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((kb) => kb.id)).toEqual(wanted);
    const queries = mockGetKnowledgeBases.mock.calls.map(
      ([options]) => options.query,
    );
    // Split at the endpoint's per-request id cap.
    expect(queries.map((query) => query.ids.length)).toEqual([250, 50]);
    for (const query of queries) {
      expect(query.includeAssignedAgents).toBe(false);
    }
  });

  it("sends nothing when there are no ids to read", () => {
    renderHook(() => useConnectorsByIds([]), { wrapper: wrapper() });

    expect(mockGetConnectors).not.toHaveBeenCalled();
  });

  it("polls the connectors it shows while one of them is syncing, and stops once none is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let syncing = true;
    mockGetConnectors.mockImplementation(
      rowsFor((id) => (id === "c-1" && syncing ? "running" : "success")),
    );

    const { result } = renderHook(
      () => useConnectorsByIds(["c-1", "c-2"], { pollWhileSyncing: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGetConnectors).toHaveBeenCalledTimes(1);
    expect(mockGetConnectors.mock.calls[0][0].query).toMatchObject({
      ids: ["c-1", "c-2"],
      includeAssignedAgents: false,
    });

    syncing = false;
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(mockGetConnectors).toHaveBeenCalledTimes(2));

    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(mockGetConnectors).toHaveBeenCalledTimes(2);
  });
});
