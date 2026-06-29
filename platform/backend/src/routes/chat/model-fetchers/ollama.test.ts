import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { fetchOllamaModels } from "./ollama";
import { PLACEHOLDER_BEARER_TOKEN } from "./types";

describe("fetchOllamaModels", () => {
  const originalBaseUrl = config.llm.ollama.baseUrl;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    config.llm.ollama.baseUrl = "https://ollama.example.com/v1";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "llama-3" }] }), {
        status: 200,
      }),
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

  test("sends bearer auth header when an API key is present", async () => {
    await fetchOllamaModels("my-key");
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer my-key",
    });
  });

  test("sends placeholder bearer token when no API key is present", async () => {
    await fetchOllamaModels("");
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: PLACEHOLDER_BEARER_TOKEN,
    });
  });

  test("uses baseUrl override when provided", async () => {
    await fetchOllamaModels("k", "https://custom.example.com/v1");
    const [url] = lastFetchCall();
    expect(url).toBe("https://custom.example.com/v1/models");
  });

  test("throws on non-2xx response with status code in message", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("error: not found", { status: 404 }),
    );
    await expect(fetchOllamaModels("k")).rejects.toThrow(
      "Failed to fetch Ollama models: 404",
    );
  });

  test("createdAt is undefined when created is missing", async () => {
    const models = await fetchOllamaModels("k");
    expect(models[0].createdAt).toBeUndefined();
  });

  test("createdAt is undefined when created is 0", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "m", created: 0 }] }), {
        status: 200,
      }),
    );
    const models = await fetchOllamaModels("k");
    expect(models[0].createdAt).toBeUndefined();
  });

  test("createdAt is set from created when present", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "m", created: 1700000000 }] }),
        { status: 200 },
      ),
    );
    const models = await fetchOllamaModels("k");
    expect(models[0].createdAt).toBe(new Date(1700000000 * 1000).toISOString());
  });
});
