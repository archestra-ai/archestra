import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLlmModels } from "./llm-models.query";

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getLlmModels: vi.fn(),
    getModelsWithApiKeys: vi.fn(),
    updateModel: vi.fn(),
    syncLlmModels: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("useLlmModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refetches when the backend reports a pending lazy model sync", async () => {
    const syncedModel = makeModel();
    vi.mocked(archestraApiSdk.getLlmModels)
      .mockResolvedValueOnce(
        makeGetLlmModelsResult([], {
          "x-archestra-lazy-model-sync": "pending",
        }),
      )
      .mockResolvedValueOnce(makeGetLlmModelsResult([syncedModel]));

    const { result } = renderHook(() => useLlmModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(1);

    await waitFor(
      () => {
        expect(archestraApiSdk.getLlmModels).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
    await waitFor(() => {
      expect(result.current.data).toEqual([syncedModel]);
    });
  });
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
