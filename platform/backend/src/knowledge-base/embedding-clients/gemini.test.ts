import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

vi.mock("@/clients/gemini-client", () => ({
  createGoogleGenAIClient: vi.fn(),
  isVertexAiEnabled: vi.fn(),
}));

import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import { callGeminiEmbedding, GeminiEmbeddingError } from "./gemini";

const mockCreateGoogleGenAIClient = vi.mocked(createGoogleGenAIClient);
const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);

describe("callGeminiEmbedding", () => {
  test("uses Gemini API model IDs outside Vertex AI", async () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    await callGeminiEmbedding({
      inputs: ["first"],
      model: "gemini-embedding-001",
      apiKey: "test-key",
    });

    expect(embedContent).toHaveBeenCalledWith({
      model: "models/gemini-embedding-001",
      contents: ["first"],
      config: undefined,
    });
  });

  test("uses Vertex-compatible model IDs in Vertex AI mode", async () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    await callGeminiEmbedding({
      inputs: ["first"],
      model: "models/gemini-embedding-2",
      apiKey: "test-key",
    });

    expect(embedContent).toHaveBeenCalledWith({
      model: "gemini-embedding-2",
      contents: ["first"],
      config: undefined,
    });
  });

  test("embeds all texts in a single SDK call", async () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }],
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    const response = await callGeminiEmbedding({
      inputs: ["first", "second"],
      model: "gemini-embedding-001",
      apiKey: "test-key",
      baseUrl: "https://example.test",
      dimensions: 1536,
    });

    expect(embedContent).toHaveBeenCalledTimes(1);
    expect(embedContent).toHaveBeenCalledWith({
      model: "models/gemini-embedding-001",
      contents: ["first", "second"],
      config: { outputDimensionality: 1536 },
    });
    expect(response).toEqual({
      object: "list",
      data: [
        { object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
        { object: "embedding", embedding: [0.4, 0.5, 0.6], index: 1 },
      ],
      model: "gemini-embedding-001",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  });

  test("throws when the SDK response does not include one embedding per input", async () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    await expect(
      callGeminiEmbedding({
        inputs: ["first", "second"],
        model: "gemini-embedding-001",
        apiKey: "test-key",
      }),
    ).rejects.toThrow(
      "Gemini embedding response did not include embeddings for each input",
    );
  });

  test("wraps SDK errors as GeminiEmbeddingError", async () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    const embedContent = vi.fn().mockRejectedValue({
      status: 429,
      message: "Rate limited",
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    await expect(
      callGeminiEmbedding({
        inputs: ["first"],
        model: "gemini-embedding-001",
        apiKey: "test-key",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GeminiEmbeddingError>>({
        name: "GeminiEmbeddingError",
        status: 429,
        message: "Rate limited",
      }),
    );
  });
});

const mockGetAccessToken = vi.hoisted(() => vi.fn());
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient() {
      return { getAccessToken: mockGetAccessToken };
    }
  },
}));

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      gemini: {
        vertexAi: {
          enabled: true,
          project: "test-project",
          location: "europe-west2",
          credentialsFile: "",
        },
      },
    },
  }),
);

describe("callGeminiEmbedding — Vertex multimodal models (predict path)", () => {
  const PREDICT_URL =
    "https://europe-west2-aiplatform.googleapis.com/v1/projects/test-project/locations/europe-west2/publishers/google/models/multimodalembedding@001:predict";
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockGetAccessToken.mockResolvedValue({ token: "test-access-token" });
    vi.stubGlobal("fetch", mockFetch);
    mockIsVertexAiEnabled.mockReturnValue(true);
  });

  const okResponse = (prediction: Record<string, unknown>) => ({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ predictions: [prediction] })),
  });

  test("rejects the model outside Vertex AI mode before any network call", async () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    await expect(
      callGeminiEmbedding({
        inputs: ["hello"],
        model: "multimodalembedding@001",
        apiKey: "test-key",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GeminiEmbeddingError",
        status: 400,
      }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreateGoogleGenAIClient).not.toHaveBeenCalled();
  });

  test("sends one predict call per text input with a bearer token and the requested dimension", async () => {
    mockFetch.mockResolvedValue(okResponse({ textEmbedding: [0.1, 0.2] }));

    const response = await callGeminiEmbedding({
      inputs: ["first", "second"],
      model: "multimodalembedding@001",
      apiKey: "unused",
      dimensions: 1408,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [callIndex, text] of ["first", "second"].entries()) {
      const [url, init] = mockFetch.mock.calls[callIndex];
      expect(url).toBe(PREDICT_URL);
      expect(init.headers.Authorization).toBe("Bearer test-access-token");
      expect(JSON.parse(init.body)).toEqual({
        instances: [{ text }],
        parameters: { dimension: 1408 },
      });
    }
    expect(response).toEqual({
      object: "list",
      data: [
        { object: "embedding", embedding: [0.1, 0.2], index: 0 },
        { object: "embedding", embedding: [0.1, 0.2], index: 1 },
      ],
      model: "multimodalembedding@001",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  });

  test("truncates text to the Vertex API's 1024-byte payload cap", async () => {
    mockFetch.mockResolvedValue(okResponse({ textEmbedding: [0.1] }));

    await callGeminiEmbedding({
      // 513 two-byte characters exceed the cap while staying below 1024 JS
      // string code units. This pins the provider's actual byte behavior.
      inputs: ["é".repeat(513)],
      model: "multimodalembedding@001",
      apiKey: "unused",
      dimensions: 1408,
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body) as {
      instances: Array<{ text: string }>;
    };
    expect(Buffer.byteLength(body.instances[0].text, "utf8")).toBe(1024);
    expect(body.instances[0].text).toHaveLength(512);
  });

  test("sends image inputs as bytesBase64Encoded instances and reads imageEmbedding", async () => {
    mockFetch.mockResolvedValue(okResponse({ imageEmbedding: [0.9, 0.8] }));

    const response = await callGeminiEmbedding({
      inputs: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      model: "multimodalembedding@001",
      apiKey: "unused",
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      instances: [{ image: { bytesBase64Encoded: "aW1hZ2U=" } }],
    });
    expect(response.data[0].embedding).toEqual([0.9, 0.8]);
  });

  test("omits the dimension parameter for dimensions the model does not offer", async () => {
    mockFetch.mockResolvedValue(okResponse({ textEmbedding: [0.1] }));

    await callGeminiEmbedding({
      inputs: ["hello"],
      model: "multimodalembedding@001",
      apiKey: "unused",
      dimensions: 1024,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ instances: [{ text: "hello" }] });
  });

  test("preserves input order across a mixed text/image batch", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ textEmbedding: [1] }))
      .mockResolvedValueOnce(okResponse({ imageEmbedding: [2] }))
      .mockResolvedValueOnce(okResponse({ textEmbedding: [3] }));

    const response = await callGeminiEmbedding({
      inputs: ["a", { mimeType: "image/jpeg", data: "anBn" }, "b"],
      model: "multimodalembedding@001",
      apiKey: "unused",
    });

    expect(response.data.map((item) => item.embedding)).toEqual([
      [1],
      [2],
      [3],
    ]);
  });

  test("surfaces the provider's HTTP error as a typed GeminiEmbeddingError", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () =>
        Promise.resolve(
          JSON.stringify({ error: { message: "Quota exceeded" } }),
        ),
    });

    await expect(
      callGeminiEmbedding({
        inputs: ["hello"],
        model: "multimodalembedding@001",
        apiKey: "unused",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GeminiEmbeddingError",
        status: 429,
        message: "Quota exceeded",
      }),
    );
  });

  test("throws a GeminiPartialEmbeddingError that banks the successes when one input fails", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ textEmbedding: [0.1] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      });

    const error = await callGeminiEmbedding({
      inputs: ["kept", "lost"],
      model: "multimodalembedding@001",
      apiKey: "unused",
    }).catch((err) => err);

    expect(error.name).toBe("GeminiPartialEmbeddingError");
    expect(error.successes).toEqual([{ index: 0, embedding: [0.1] }]);
    expect(error.failures).toHaveLength(1);
    expect(error.failures[0].index).toBe(1);
    expect(error.failures[0].reason).toBeInstanceOf(GeminiEmbeddingError);
  });

  test("throws when the response carries no prediction for the input", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ predictions: [] })),
    });

    await expect(
      callGeminiEmbedding({
        inputs: ["hello"],
        model: "multimodalembedding@001",
        apiKey: "unused",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GeminiEmbeddingError",
        status: 500,
      }),
    );
  });

  test("rejects an image over the model's size cap before spending a request", async () => {
    const oversized = "a".repeat(28 * 1024 * 1024);

    await expect(
      callGeminiEmbedding({
        inputs: [{ mimeType: "image/png", data: oversized }],
        model: "multimodalembedding@001",
        apiKey: "unused",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GeminiEmbeddingError",
        status: 400,
      }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
