import { HttpResponse, http } from "msw";
import { beforeEach, vi } from "vitest";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string[]; dimensions?: number };
}

const capturedRequests: CapturedRequest[] = [];

// openai@6 requests base64 embeddings by default and decodes them client-side,
// so the wire payload must carry Float32Array bytes, not a JSON number array.
function encodeEmbedding(values: number[]): string {
  const floats = new Float32Array(values);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString("base64");
}

// Deployment-scoped embeddings endpoints the tests exercise. Exact URLs (not a
// wildcard) — path-to-regexp@8 chokes on MSW's `*` param under this msw build.
const EMBEDDINGS_URL = {
  small:
    "https://resource.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings",
  large:
    "https://resource.openai.azure.com/openai/deployments/text-embedding-3-large/embeddings",
  v1: "https://resource.services.ai.azure.com/openai/v1/embeddings",
} as const;

const embeddingResolver = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const body = (await request.json()) as {
    model: string;
    input: string[];
    dimensions?: number;
  };
  capturedRequests.push({
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: {
      model: body.model,
      input: body.input,
      dimensions: body.dimensions,
    },
  });
  return HttpResponse.json({
    object: "list",
    data: [
      {
        object: "embedding",
        embedding: encodeEmbedding([0.1, 0.2]),
        index: 0,
      },
    ],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 4, total_tokens: 4 },
  });
};

const defaultHandlers = [
  http.post(EMBEDDINGS_URL.small, embeddingResolver),
  http.post(EMBEDDINGS_URL.large, embeddingResolver),
  http.post(EMBEDDINGS_URL.v1, embeddingResolver),
];

const mockIsAzureOpenAiEntraIdEnabled = vi.hoisted(() => vi.fn());
const mockGetAzureOpenAiBearerTokenProvider = vi.hoisted(() => vi.fn());

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureOpenAiBearerTokenProvider: mockGetAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled: mockIsAzureOpenAiEntraIdEnabled,
}));

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      azure: {
        apiVersion: "2024-02-01",
        baseUrl: "https://fallback-resource.openai.azure.com/openai",
      },
    },
  }),
);

import { type AzureEmbeddingError, callAzureEmbedding } from "./azure";

describe("callAzureEmbedding", () => {
  const server = useMswServer(...defaultHandlers);

  beforeEach(() => {
    capturedRequests.length = 0;
    mockIsAzureOpenAiEntraIdEnabled.mockReset();
    mockGetAzureOpenAiBearerTokenProvider.mockReset();
  });

  test("uses Azure deployment-scoped embeddings endpoint with api-key auth", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);

    const response = await callAzureEmbedding({
      inputs: ["hello"],
      model: "text-embedding-3-small",
      apiKey: "azure-key",
      baseUrl: "https://resource.openai.azure.com/openai",
      dimensions: 1536,
    });

    // Float32 wire encoding is lossy, so assert closeness rather than equality.
    expect(response.data[0].embedding).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
    ]);

    expect(capturedRequests).toHaveLength(1);
    const [req] = capturedRequests;
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://resource.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings",
    );
    expect(url.searchParams.get("api-version")).toBe("2024-02-01");
    expect(req.headers["api-key"]).toBe("azure-key");
    expect(req.body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 1536,
    });
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

    const [req] = capturedRequests;
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://resource.openai.azure.com/openai/deployments/text-embedding-3-large/embeddings",
    );
    // defaultHeaders (Entra bearer) override the SDK's default api-key auth header.
    expect(req.headers.authorization).toBe("Bearer entra-token");
  });

  test("preserves Azure OpenAI v1 base URLs without api-version injection", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);

    await callAzureEmbedding({
      inputs: ["hello"],
      model: "text-embedding-3-small",
      apiKey: "azure-key",
      baseUrl: "https://resource.services.ai.azure.com/openai/v1",
    });

    const [req] = capturedRequests;
    const url = new URL(req.url);
    expect(url.href).toBe(
      "https://resource.services.ai.azure.com/openai/v1/embeddings",
    );
    expect(url.searchParams.has("api-version")).toBe(false);
    expect(req.headers["api-key"]).toBe("azure-key");
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
    // x-should-retry: false disables the SDK's own 429 retry loop so the
    // rate-limit error surfaces immediately with its retry-after header intact.
    server.use(
      http.post(EMBEDDINGS_URL.small, () =>
        HttpResponse.json(
          {
            error: {
              message: "Please retry after 60 seconds.",
              type: "rate_limit_exceeded",
            },
          },
          {
            status: 429,
            headers: { "retry-after": "45", "x-should-retry": "false" },
          },
        ),
      ),
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
      retryAfterMs: 45_000,
    } satisfies Partial<AzureEmbeddingError>);
  });

  test("falls back to Azure retry-after message when header is missing", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    server.use(
      http.post(EMBEDDINGS_URL.small, () =>
        HttpResponse.json(
          {
            error: {
              message: "Please retry after 60 seconds.",
              type: "rate_limit_exceeded",
            },
          },
          { status: 429, headers: { "x-should-retry": "false" } },
        ),
      ),
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
