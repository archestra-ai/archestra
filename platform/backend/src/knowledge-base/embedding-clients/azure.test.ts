import { beforeEach, vi } from "vitest";
import { describe, expect, test } from "@/test";

const mockEmbeddingsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    object: "list",
    data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 4, total_tokens: 4 },
  }),
);
const mockOpenAIConstructor = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class MockOpenAI {
    static APIError = class APIError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    };

    embeddings = { create: mockEmbeddingsCreate };

    constructor(options: unknown) {
      mockOpenAIConstructor(options);
    }
  }
  return { default: MockOpenAI };
});

const mockIsAzureOpenAiEntraIdEnabled = vi.hoisted(() => vi.fn());
const mockGetAzureOpenAiBearerTokenProvider = vi.hoisted(() => vi.fn());

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureOpenAiBearerTokenProvider: mockGetAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled: mockIsAzureOpenAiEntraIdEnabled,
}));

vi.mock("@/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/config")>();
  return {
    ...original,
    default: {
      ...original.default,
      llm: {
        ...original.default.llm,
        azure: {
          ...original.default.llm.azure,
          apiVersion: "2024-02-01",
          baseUrl: "https://fallback-resource.openai.azure.com/openai",
        },
      },
    },
  };
});

import { type AzureEmbeddingError, callAzureEmbedding } from "./azure";

describe("callAzureEmbedding", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockEmbeddingsCreate.mockClear();
    mockOpenAIConstructor.mockClear();
    mockIsAzureOpenAiEntraIdEnabled.mockReset();
    mockGetAzureOpenAiBearerTokenProvider.mockReset();
  });

  test("uses Azure deployment-scoped embeddings endpoint with api-key auth", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await callAzureEmbedding({
      inputs: ["hello"],
      model: "text-embedding-3-small",
      apiKey: "azure-key",
      baseUrl: "https://resource.openai.azure.com/openai",
      dimensions: 1536,
    });

    expect(response.data[0].embedding).toEqual([0.1, 0.2]);
    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      apiKey: "azure-key",
      baseURL:
        "https://resource.openai.azure.com/openai/deployments/text-embedding-3-small",
      defaultHeaders: { "api-key": "azure-key" },
      fetch: expect.any(Function),
    });
    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 1536,
    });

    const [{ fetch }] = mockOpenAIConstructor.mock.calls[0] as [
      { fetch: typeof globalThis.fetch },
    ];
    await fetch("https://resource.openai.azure.com/openai/test?existing=1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://resource.openai.azure.com/openai/test?existing=1&api-version=2024-02-01",
      undefined,
    );

    vi.unstubAllGlobals();
  });

  test("uses Azure Entra bearer auth for keyless embedding config", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);
    const tokenProvider = vi.fn().mockResolvedValue("entra-token");
    mockGetAzureOpenAiBearerTokenProvider.mockReturnValue(tokenProvider);

    await callAzureEmbedding({
      inputs: ["hello"],
      model: "text-embedding-3-large",
      apiKey: "unused",
      baseUrl: "https://resource.openai.azure.com/openai",
    });

    expect(mockGetAzureOpenAiBearerTokenProvider).toHaveBeenCalledWith(
      "https://resource.openai.azure.com/openai",
    );
    expect(mockOpenAIConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "unused",
        baseURL:
          "https://resource.openai.azure.com/openai/deployments/text-embedding-3-large",
        defaultHeaders: { Authorization: "Bearer entra-token" },
      }),
    );
  });

  test("preserves Azure OpenAI v1 base URLs without api-version injection", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);

    await callAzureEmbedding({
      inputs: ["hello"],
      model: "text-embedding-3-small",
      apiKey: "azure-key",
      baseUrl: "https://resource.services.ai.azure.com/openai/v1",
    });

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      apiKey: "azure-key",
      baseURL: "https://resource.services.ai.azure.com/openai/v1",
      defaultHeaders: { "api-key": "azure-key" },
      fetch: undefined,
    });
  });

  test("throws on invalid Azure base URL", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);

    await expect(
      callAzureEmbedding({
        inputs: ["hello"],
        model: "text-embedding-3-small",
        apiKey: "azure-key",
        baseUrl: "https://not-azure.example.com/something",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Azure embedding base URL"),
    });
  });

  test("preserves Azure retry-after from rate-limit errors", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    const OpenAI = (await import("openai")).default;
    const MockApiError = OpenAI.APIError as unknown as new (
      status: number,
      message: string,
    ) => Error & { status: number };
    const error = Object.assign(
      new MockApiError(429, "Please retry after 60 seconds."),
      {
        headers: { "retry-after": "45" },
      },
    );
    mockEmbeddingsCreate.mockRejectedValueOnce(error);

    await expect(
      callAzureEmbedding({
        inputs: ["hello"],
        model: "text-embedding-3-small",
        apiKey: "azure-key",
        baseUrl: "https://resource.openai.azure.com/openai",
      }),
    ).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 45_000,
    } satisfies Partial<AzureEmbeddingError>);
  });

  test("falls back to Azure retry-after message when header is missing", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    const OpenAI = (await import("openai")).default;
    const MockApiError = OpenAI.APIError as unknown as new (
      status: number,
      message: string,
    ) => Error & { status: number };
    mockEmbeddingsCreate.mockRejectedValueOnce(
      new MockApiError(429, "Please retry after 60 seconds."),
    );

    await expect(
      callAzureEmbedding({
        inputs: ["hello"],
        model: "text-embedding-3-small",
        apiKey: "azure-key",
        baseUrl: "https://resource.openai.azure.com/openai",
      }),
    ).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 60_000,
    } satisfies Partial<AzureEmbeddingError>);
  });

  test("rejects image inputs", async () => {
    await expect(
      callAzureEmbedding({
        inputs: [{ mimeType: "image/png", data: "abc" }],
        model: "text-embedding-3-small",
        apiKey: "azure-key",
        baseUrl: "https://resource.openai.azure.com/openai",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("do not support image inputs"),
    } satisfies Partial<AzureEmbeddingError>);
  });
});
