import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetConnectorRuns = vi.fn();
const mockUseQuery = vi.fn();

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getConnectors: vi.fn(),
    getConnector: vi.fn(),
    createConnector: vi.fn(),
    updateConnector: vi.fn(),
    deleteConnector: vi.fn(),
    syncConnector: vi.fn(),
    forceResyncConnector: vi.fn(),
    testConnectorConnection: vi.fn(),
    getConnectorRuns: (...args: unknown[]) => mockGetConnectorRuns(...args),
    getConnectorRun: vi.fn(),
    assignConnectorToKnowledgeBases: vi.fn(),
    unassignConnectorFromKnowledgeBase: vi.fn(),
    getConnectorKnowledgeBases: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );

  return {
    ...actual,
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
  };
});

import { useConnectorRuns } from "./connector.query";

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useConnectorRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((options) => options);
  });

  it("keeps polling when the connector is marked running even before a run row appears", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["connectors", "connector-1"], {
      id: "connector-1",
      lastSyncStatus: "running",
    });

    const { result } = renderHook(
      () => useConnectorRuns({ connectorId: "connector-1" }),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current).toBeDefined();
    const options = mockUseQuery.mock.calls[0][0] as {
      refetchInterval: (query: {
        state: { data: { data: unknown[] } };
      }) => number | false;
    };

    const interval = options.refetchInterval({
      state: { data: { data: [] } },
    });

    expect(interval).toBe(3000);
  });

  it("stops polling when neither the connector nor any run is running", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["connectors", "connector-1"], {
      id: "connector-1",
      lastSyncStatus: "failed",
    });

    const { result } = renderHook(
      () => useConnectorRuns({ connectorId: "connector-1" }),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current).toBeDefined();
    const options = mockUseQuery.mock.calls[0][0] as {
      refetchInterval: (query: {
        state: { data: { data: Array<{ id: string; status: string }> } };
      }) => number | false;
    };

    const interval = options.refetchInterval({
      state: { data: { data: [{ id: "run-1", status: "failed" }] } },
    });

    expect(interval).toBe(false);
  });
});
