import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { fetchOllamaModels } from "./ollama";

describe("fetchOllamaModels", () => {
  const originalBaseUrl = config.llm.ollama.baseUrl;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    config.llm.ollama.baseUrl = "http://ollama.example.com";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "llama3", created: 1714000000 }] }),
        { status: 200 },
      ),
    );
  });

  afterEach(() => {
    config.llm.ollama.baseUrl = originalBaseUrl;
    vi.restoreAllMocks();
  });

  function lastFetchCall() {
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    return call;
  }

  test("sends bearer auth header when API key is provided", async () => {
    await fetchOllamaModels("my-key");
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer my-key",
    });
  });

  test("sends placeholder bearer token when API key is empty", async () => {
    await fetchOllamaModels("");
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: expect.stringContaining("Bearer"),
    });
  });

  test("merges extraHeaders alongside authorization", async () => {
    await fetchOllamaModels("my-key", null, { "x-custom": "value" });
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toMatchObject({
      "x-custom": "value",
      Authorization: "Bearer my-key",
    });
  });

  test("uses baseUrl override when provided", async () => {
    await fetchOllamaModels("k", "http://custom.example.com");
    const [url] = lastFetchCall();
    expect(url).toBe("http://custom.example.com/models");
  });

  test("throws on connection failure without Docker hint for non-localhost URL", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    config.llm.ollama.baseUrl = "http://remote.example.com";
    await expect(fetchOllamaModels("k")).rejects.toThrow(/ECONNREFUSED/);
    await expect(fetchOllamaModels("k")).rejects.not.toThrow(/Docker/);
  });

  test("appends Docker hint on connection failure for localhost URL", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      fetchOllamaModels("k", "http://localhost:11434"),
    ).rejects.toThrow(/Docker/);
  });

  test("appends Docker hint on connection failure for 127.0.0.1 URL", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      fetchOllamaModels("k", "http://127.0.0.1:11434"),
    ).rejects.toThrow(/Docker/);
  });

  test("throws on non-2xx response with status code in message", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await expect(fetchOllamaModels("bad-key")).rejects.toThrow(
      "Failed to fetch Ollama models: 401",
    );
  });

  test("maps models correctly from response", async () => {
    const models = await fetchOllamaModels("k");
    expect(models).toEqual([
      {
        id: "llama3",
        displayName: "llama3",
        provider: "ollama",
        createdAt: new Date(1714000000 * 1000).toISOString(),
      },
    ]);
  });

  test("handles missing createdAt field", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "llama3" }] }), { status: 200 }),
    );
    const models = await fetchOllamaModels("k");
    expect(models[0].createdAt).toBeUndefined();
  });
});
