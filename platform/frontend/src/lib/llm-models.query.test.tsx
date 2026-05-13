import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInfiniteLlmModels, useLlmModelsPage } from "./llm-models.query";

vi.mock("@shared", async () => {
  const actual = await vi.importActual("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      getLlmModels: vi.fn(),
      getModelsWithApiKeys: vi.fn(),
      updateModel: vi.fn(),
      syncLlmModels: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual("@/lib/utils");
  return {
    ...actual,
    handleApiError: vi.fn(),
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("llm model query hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches one paginated page for useLlmModelsPage", async () => {
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValueOnce({
      data: {
        data: [makeModel("gpt-4.1")],
        pagination: makePagination({
          currentPage: 1,
          limit: 50,
          total: 2,
          totalPages: 2,
          hasNext: true,
          hasPrev: false,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>);

    const { result } = renderHook(
      () => useLlmModelsPage({ provider: "openai", limit: 50 }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.data.map((model) => model.id)).toEqual([
      "gpt-4.1",
    ]);
    expect(result.current.data?.pagination.hasNext).toBe(true);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledWith({
      query: { provider: "openai", limit: 50 },
    });
  });

  it("uses the next numeric offset for infinite model pagination", async () => {
    vi.mocked(archestraApiSdk.getLlmModels)
      .mockResolvedValueOnce({
        data: {
          data: [makeModel("gpt-4.1")],
          pagination: makePagination({
            currentPage: 1,
            limit: 50,
            total: 2,
            totalPages: 2,
            hasNext: true,
            hasPrev: false,
          }),
        },
      } as unknown as Awaited<
        ReturnType<typeof archestraApiSdk.getLlmModels>
      >)
      .mockResolvedValueOnce({
        data: {
          data: [makeModel("gpt-4.1-mini")],
          pagination: makePagination({
            currentPage: 2,
            limit: 50,
            total: 2,
            totalPages: 2,
            hasNext: false,
            hasPrev: true,
          }),
        },
      } as unknown as Awaited<
        ReturnType<typeof archestraApiSdk.getLlmModels>
      >);

    const { result } = renderHook(
      () => useInfiniteLlmModels({ provider: "openai", limit: 50 }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await result.current.fetchNextPage();

    expect(archestraApiSdk.getLlmModels).toHaveBeenNthCalledWith(1, {
      query: { provider: "openai", limit: 50, offset: 0 },
    });
    expect(archestraApiSdk.getLlmModels).toHaveBeenNthCalledWith(2, {
      query: { provider: "openai", limit: 50, offset: 50 },
    });
  });
});

function makeModel(id: string) {
  return {
    id,
    dbId: id,
    displayName: id,
    provider: "openai" as const,
    capabilities: null,
    isBest: false,
    isFastest: false,
    isFree: false,
    embeddingDimensions: null,
  };
}

function makePagination(pagination: {
  currentPage: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}) {
  return pagination;
}
