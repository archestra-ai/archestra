import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { fetchOllamaModels } from "./ollama";
import { PLACEHOLDER_BEARER_TOKEN } from "./types";

/**
 * The fetcher issues one GET `/v1/models` list call plus one POST `/api/show`
 * per model. Tests dispatch a fresh Response per call by URL so bodies are never
 * re-read, and default `/api/show` to a 404 unless a test provides a handler.
 */
describe("fetchOllamaModels", () => {
  const originalBaseUrl = config.llm.ollama.baseUrl;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let listBody: unknown;
  let showByModel: Record<string, { status?: number; body?: unknown }>;

  beforeEach(() => {
    config.llm.ollama.baseUrl = "https://ollama.example.com/v1";
    listBody = { data: [{ id: "llama-3" }] };
    showByModel = {};
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.endsWith("/api/show")) {
          const model = JSON.parse(String(init?.body ?? "{}")).model as string;
          const show = showByModel[model];
          if (!show) return new Response("not found", { status: 404 });
          return new Response(JSON.stringify(show.body ?? {}), {
            status: show.status ?? 200,
          });
        }
        return new Response(JSON.stringify(listBody), { status: 200 });
      });
  });

  afterEach(() => {
    config.llm.ollama.baseUrl = originalBaseUrl;
    vi.restoreAllMocks();
  });

  function listCall() {
    const call = fetchSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith("/v1/models"),
    );
    if (!call) throw new Error("list fetch was not called");
    return call;
  }

  test("sends bearer auth header on the list call when an API key is present", async () => {
    await fetchOllamaModels("my-key");
    const [, init] = listCall();
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer my-key",
    });
  });

  test("sends placeholder bearer token when no API key is present", async () => {
    await fetchOllamaModels("");
    const [, init] = listCall();
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: PLACEHOLDER_BEARER_TOKEN,
    });
  });

  test("uses baseUrl override for the list call", async () => {
    await fetchOllamaModels("k", "https://custom.example.com/v1");
    const [url] = listCall();
    expect(url).toBe("https://custom.example.com/v1/models");
  });

  test("throws on non-2xx list response with status code in message", async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response("error: not found", { status: 404 }),
    );
    await expect(fetchOllamaModels("k")).rejects.toThrow(/404/);
  });

  test("createdAt is set from created when present, undefined otherwise", async () => {
    listBody = {
      data: [
        { id: "a" },
        { id: "b", created: 0 },
        { id: "c", created: 1700000000 },
      ],
    };
    const models = await fetchOllamaModels("k");
    expect(models[0].createdAt).toBeUndefined();
    expect(models[1].createdAt).toBeUndefined();
    expect(models[2].createdAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  test("queries /api/show at the Ollama root (without /v1) via POST", async () => {
    await fetchOllamaModels("k");
    const showCall = fetchSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith("/api/show"),
    );
    expect(showCall?.[0]).toBe("https://ollama.example.com/api/show");
    expect((showCall?.[1] as RequestInit)?.method).toBe("POST");
  });

  test("classifies an embedding model authoritatively with its native dimension", async () => {
    listBody = { data: [{ id: "mxbai-embed-large" }] };
    showByModel["mxbai-embed-large"] = {
      body: {
        capabilities: ["embedding"],
        model_info: {
          "bert.embedding_length": 1024,
          "bert.context_length": 512,
        },
      },
    };
    const [model] = await fetchOllamaModels("k");
    expect(model.capabilities?.embeddingDimensions).toBe(1024);
    expect(model.capabilities?.contextLength).toBe(512);
  });

  test("leaves embeddingDimensions undefined for an embedding model with no reported dimension so the heuristic can still resolve it", async () => {
    listBody = { data: [{ id: "mystery-embed" }] };
    showByModel["mystery-embed"] = { body: { capabilities: ["embedding"] } };
    const [model] = await fetchOllamaModels("k");
    expect(model.capabilities?.embeddingDimensions).toBeUndefined();
  });

  test("classifies a generative model as non-embedding (null) and reads context length", async () => {
    listBody = { data: [{ id: "llama3" }] };
    showByModel.llama3 = {
      body: {
        capabilities: ["completion", "tools"],
        model_info: { "llama.context_length": 8192 },
      },
    };
    const [model] = await fetchOllamaModels("k");
    expect(model.capabilities?.embeddingDimensions).toBeNull();
    expect(model.capabilities?.contextLength).toBe(8192);
  });

  test("leaves embeddingDimensions undefined when /api/show omits capabilities (older Ollama)", async () => {
    listBody = { data: [{ id: "legacy" }] };
    showByModel.legacy = {
      body: { model_info: { "llama.context_length": 4096 } },
    };
    const [model] = await fetchOllamaModels("k");
    expect(model.capabilities?.embeddingDimensions).toBeUndefined();
    expect(model.capabilities?.contextLength).toBe(4096);
  });

  test("degrades to no capabilities when /api/show fails", async () => {
    listBody = { data: [{ id: "llama3" }] };
    // No showByModel entry → default 404.
    const [model] = await fetchOllamaModels("k");
    expect(model.capabilities).toBeUndefined();
    expect(model.id).toBe("llama3");
  });

  test("parses default parameters, coalescing repeated keys and keeping quoted values as strings", async () => {
    listBody = { data: [{ id: "llama3" }] };
    showByModel.llama3 = {
      body: {
        capabilities: ["completion"],
        parameters: [
          "num_ctx                        4096",
          "temperature                    0.7",
          'stop                           "<|im_start|>"',
          'stop                           "<|im_end|>"',
          'stop                           "128"',
        ].join("\n"),
      },
    };
    const [model] = await fetchOllamaModels("k");
    expect(model.capabilities?.defaultParameters).toEqual({
      num_ctx: 4096,
      temperature: 0.7,
      stop: ["<|im_start|>", "<|im_end|>", "128"],
    });
  });
});
