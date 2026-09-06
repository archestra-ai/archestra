import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAZY_MODEL_SYNC_REFETCH_DELAY_MS,
  useLlmModels,
} from "./llm-models.query";
import { PERSISTED_QUERY_META } from "./query-persistence";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getLlmModels: vi.fn(),
    getModelsWithApiKeys: vi.fn(),
    updateModel: vi.fn(),
    syncLlmModels: vi.fn(),
  },
  LAZY_MODEL_SYNC_STATUS_HEADER: "x-archestra-lazy-model-sync",
  LAZY_MODEL_SYNC_STATUS_PENDING: "pending",
}));

vi.mock("sonner");

describe("useLlmModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refetches once after a pending lazy model sync, then stops", async () => {
    const syncedModel = makeModel();
    vi.mocked(archestraApiSdk.getLlmModels)
      .mockResolvedValueOnce(
        makeGetLlmModelsResult([], {
          "x-archestra-lazy-model-sync": "pending",
        }),
      )
      .mockResolvedValueOnce(makeGetLlmModelsResult([syncedModel]));

    renderHook(() => useLlmModels(), {
      wrapper: createWrapper(),
    });

    await flushQuery();
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_MODEL_SYNC_REFETCH_DELAY_MS);
    });
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(2);

    // the second response is no longer pending, so no further refetch is armed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_MODEL_SYNC_REFETCH_DELAY_MS * 2);
    });
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when no lazy sync is pending", async () => {
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValue(
      makeGetLlmModelsResult([makeModel()]),
    );

    renderHook(() => useLlmModels(), { wrapper: createWrapper() });

    await flushQuery();
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_MODEL_SYNC_REFETCH_DELAY_MS * 2);
    });
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);
  });

  it("marks the model catalog for session restoration", async () => {
    vi.mocked(archestraApiSdk.getLlmModels).mockResolvedValue(
      makeGetLlmModelsResult([makeModel()]),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(() => useLlmModels(), {
      wrapper: createWrapper(queryClient),
    });
    await flushQuery();

    expect(
      queryClient.getQueryCache().find({ queryKey: ["llm-models", null] })
        ?.meta,
    ).toEqual(PERSISTED_QUERY_META);
  });

  // A transient catalog failure must self-heal: the app-wide default is
  // `retry: false`, so without the query's own retry a single blip left the
  // new-chat composer stranded on "Select model" with no default (T-1317).
  it("recovers the model catalog after a transient fetch failure", async () => {
    // Real timers + retryDelay: 0 so the retry is instant without the fake
    // timers the other cases install for the lazy-sync refetch.
    vi.useRealTimers();
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
});

async function flushQuery() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

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
  headers?: HeadersInit,
): Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>> {
  return {
    data,
    error: undefined,
    request: new Request("http://localhost/api/llm-models/available"),
    response: new Response(null, { headers }),
  } as Awaited<ReturnType<typeof archestraApiSdk.getLlmModels>>;
}
