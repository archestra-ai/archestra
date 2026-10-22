import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLlmModels, useModelsWithApiKeys } from "./llm-models.query";
import { llmModelsQueryKey } from "./llm-models-query-keys";
import { availableLlmProviderApiKeysQueryKey } from "./llm-provider-api-keys-query-keys";
import { PERSISTED_QUERY_META } from "./query-persistence";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getLlmModels: vi.fn(),
    getModelsWithApiKeys: vi.fn(),
    updateModel: vi.fn(),
    syncLlmModels: vi.fn(),
  },
}));

vi.mock("sonner");

describe("useLlmModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the model catalog for session restoration", async () => {
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValue(
      makeGetLlmModelsResult([makeModel()]),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useLlmModels(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(
      queryClient.getQueryCache().find({ queryKey: ["llm-models", null] })
        ?.meta,
    ).toEqual(PERSISTED_QUERY_META);
  });

  // A transient catalog failure must self-heal: the app-wide default is
  // `retry: false`, so without the query's own retry a single blip left the
  // new-chat composer stranded on "Select model" with no default (T-1317).
  it("recovers the model catalog after a transient fetch failure", async () => {
    // retryDelay: 0 so the retry is instant.
    vi.mocked(archestraApiSdk.getLlmModels)
      .mockResolvedValueOnce({
        data: undefined,
        error: {
          error: { message: "boom", type: "api_internal_server_error" },
        },
        request: new Request("http://localhost/api/llm-models/available"),
        response: new Response(null),
      } as never)
      .mockResolvedValueOnce(makeGetLlmModelsResult([makeModel()]));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const { result } = renderHook(() => useLlmModels(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(2);
  });

  // Adding the first key refetches the full list; until that lands the cache
  // still holds the empty answer from before the key's models were synced.
  // The sole key's list must wait for the refetch, not latch that empty list.
  it("does not seed the sole key's models from a list being refetched", async () => {
    let resolveRefetch: (value: unknown) => void = () => {};
    vi.mocked(archestraApiSdk.getLlmModels).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      }) as never,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    queryClient.setQueryData(llmModelsQueryKey(null), []);
    queryClient.setQueryData(
      availableLlmProviderApiKeysQueryKey(undefined, undefined),
      [{ id: "key-1" }],
    );
    renderHook(() => useLlmModels(), {
      wrapper: createWrapper(queryClient),
    });
    void queryClient.invalidateQueries({ queryKey: llmModelsQueryKey(null) });

    const { result } = renderHook(() => useLlmModels({ apiKeyId: "key-1" }), {
      wrapper: createWrapper(queryClient),
    });
    resolveRefetch(makeGetLlmModelsResult([makeModel()]));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);
  });
});

describe("useModelsWithApiKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(archestraApiSdk.getModelsWithApiKeys).mockResolvedValue({
      data: [],
    } as never);
  });

  it("sends a picker's filters and keeps it apart from the full catalog", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => ({
        full: useModelsWithApiKeys(),
        picker: useModelsWithApiKeys({
          apiKeyIds: ["key-1"],
          includeAssignments: false,
        }),
      }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() =>
      expect(
        result.current.full.isSuccess && result.current.picker.isSuccess,
      ).toBe(true),
    );
    expect(
      vi
        .mocked(archestraApiSdk.getModelsWithApiKeys)
        .mock.calls.map(([options]) => options?.query),
    ).toEqual([{}, { apiKeyIds: ["key-1"], includeAssignments: false }]);
  });
});

function createWrapper(
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeModel(): archestraApiTypes.GetLlmModelsResponses["200"][number] {
  return {
    id: "gpt-4o",
    dbId: "model-1",
    displayName: "GPT-4o",
    provider: "openai",
    isFree: false,
  };
}

function makeGetLlmModelsResult(
  data: archestraApiTypes.GetLlmModelsResponses["200"],
): Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>> {
  return {
    data,
    error: undefined,
    request: new Request("http://localhost/api/llm-models/available"),
    response: new Response(null),
  } as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>;
}
