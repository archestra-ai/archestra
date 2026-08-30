import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseQuery = vi.fn();

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getRetrievalEvaluationCapabilities: vi.fn(),
    previewRetrievalEvaluationCapabilities: vi.fn(),
    listRetrievalEvaluationRuns: vi.fn(),
    getRetrievalEvaluationRun: vi.fn(),
    startRetrievalEvaluation: vi.fn(),
    cancelRetrievalEvaluation: vi.fn(),
    compareRetrievalEvaluations: vi.fn(),
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

import {
  useRetrievalEvaluationCapabilitiesPreview,
  useRetrievalEvaluationRuns,
} from "./retrieval-evaluation.query";

describe("useRetrievalEvaluationRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((options) => options);
  });

  it("polls while any durable evaluation run is active", () => {
    const { result } = renderHook(() => useRetrievalEvaluationRuns(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBeDefined();
    const options = mockUseQuery.mock.calls[0][0] as {
      refetchInterval: (query: {
        state: { data: Array<{ status: string }> };
      }) => number | false;
    };
    expect(
      options.refetchInterval({ state: { data: [{ status: "running" }] } }),
    ).toBe(2_000);
    expect(
      options.refetchInterval({
        state: { data: [{ status: "cancel_requested" }] },
      }),
    ).toBe(2_000);
  });

  it("stops polling when every run is terminal", () => {
    const { result } = renderHook(() => useRetrievalEvaluationRuns(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBeDefined();
    const options = mockUseQuery.mock.calls[0][0] as {
      refetchInterval: (query: {
        state: { data: Array<{ status: string }> };
      }) => number | false;
    };
    expect(
      options.refetchInterval({
        state: { data: [{ status: "completed" }, { status: "blocked" }] },
      }),
    ).toBe(false);
  });

  it("previews the exact run-only settings", async () => {
    vi.mocked(
      archestraApiSdk.previewRetrievalEvaluationCapabilities,
    ).mockResolvedValue({
      data: { components: [] },
      error: undefined,
    } as never);
    const settingsOverrides = {
      embedding: { chatApiKeyId: "key-1", model: "embed-1" },
      bm25K1: 0.6,
      bm25B: 0.35,
      contextualRetrievalMode: "document" as const,
    };

    renderHook(
      () =>
        useRetrievalEvaluationCapabilitiesPreview({
          settingsOverrides,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    const options = mockUseQuery.mock.calls[0][0] as {
      queryFn: () => Promise<unknown>;
    };
    await options.queryFn();

    expect(
      archestraApiSdk.previewRetrievalEvaluationCapabilities,
    ).toHaveBeenCalledWith({ body: settingsOverrides });
  });
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
