import { archestraApiSdk, type SupportedProvider } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableLlmModelQueryOptions,
  fetchPreferredLlmModelForApiKey,
  preferredLlmModelForApiKeyQueryOptions,
  useAvailableLlmModel,
  useInfiniteLlmModels,
  useLlmModelsPage,
} from "./llm-models.query";

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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 60_000 },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient = createQueryClient()) {
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

  it("reuses available model data fetched through the shared query options", async () => {
    const queryClient = createQueryClient();
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValueOnce({
      data: {
        data: [makeModel("anthropic/claude-haiku-4.5", "anthropic")],
        pagination: makePagination({
          currentPage: 1,
          limit: 1,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>);

    const params = {
      apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
      modelId: "anthropic/claude-haiku-4.5",
    };

    const prefetchedModel = await queryClient.fetchQuery(
      availableLlmModelQueryOptions(params),
    );

    const { result } = renderHook(() => useAvailableLlmModel(params), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(prefetchedModel));
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledWith({
      query: {
        apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
        modelId: "anthropic/claude-haiku-4.5",
        limit: 1,
        offset: 0,
      },
    });
  });

  it("normalizes exact available model lookups with an API key across provider variants", async () => {
    const queryClient = createQueryClient();
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValueOnce({
      data: {
        data: [makeModel("openai/gpt-4.1", "openrouter")],
        pagination: makePagination({
          currentPage: 1,
          limit: 1,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>);

    const params = {
      apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
      modelId: "openai/gpt-4.1",
    };

    const prefetchedModel = await queryClient.fetchQuery(
      availableLlmModelQueryOptions({
        ...params,
        provider: "openrouter",
      }),
    );

    const { result } = renderHook(() => useAvailableLlmModel(params), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(prefetchedModel));
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledWith({
      query: {
        apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
        modelId: "openai/gpt-4.1",
        limit: 1,
        offset: 0,
      },
    });
  });

  it("keeps provider on preferred model fallback lookups", async () => {
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValueOnce({
      data: {
        data: [makeModel("openai/gpt-4.1", "openrouter")],
        pagination: makePagination({
          currentPage: 1,
          limit: 1,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>);

    await fetchPreferredLlmModelForApiKey({
      apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
      provider: "openrouter",
    });

    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledWith({
      query: {
        apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
        provider: "openrouter",
        limit: 1,
        offset: 0,
      },
    });
  });

  it("reuses preferred model fallback lookups through the shared query options", async () => {
    const queryClient = createQueryClient();
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValueOnce({
      data: {
        data: [makeModel("openai/gpt-4.1", "openrouter")],
        pagination: makePagination({
          currentPage: 1,
          limit: 1,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>);

    const params = {
      apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
      provider: "openrouter" as const,
    };

    const first = await queryClient.fetchQuery(
      preferredLlmModelForApiKeyQueryOptions(params),
    );
    const second = await queryClient.fetchQuery(
      preferredLlmModelForApiKeyQueryOptions(params),
    );

    expect(second).toEqual(first);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledWith({
      query: {
        apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
        provider: "openrouter",
        limit: 1,
        offset: 0,
      },
    });
  });

  it("reuses exact model data for preferred best model lookups", async () => {
    const queryClient = createQueryClient();
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValueOnce({
      data: {
        data: [makeModel("openai/gpt-4.1", "openrouter")],
        pagination: makePagination({
          currentPage: 1,
          limit: 1,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>);

    const params = {
      apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
      bestModelId: "openai/gpt-4.1",
      provider: "openrouter" as const,
    };

    const preferredModel = await queryClient.fetchQuery(
      preferredLlmModelForApiKeyQueryOptions(params),
    );
    const exactModel = await queryClient.fetchQuery(
      availableLlmModelQueryOptions({
        apiKeyId: params.apiKeyId,
        modelId: params.bestModelId,
      }),
    );

    expect(exactModel).toEqual(preferredModel);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledWith({
      query: {
        apiKeyId: "c808af78-39a1-4491-8f8d-5d8c6f6e663a",
        modelId: "openai/gpt-4.1",
        limit: 1,
        offset: 0,
      },
    });
  });
});

function makeModel(id: string, provider: SupportedProvider = "openai") {
  return {
    id,
    dbId: id,
    displayName: id,
    provider,
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
