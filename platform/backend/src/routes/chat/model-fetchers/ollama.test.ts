import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { fetchOllamaModels } from "./ollama";

describe("fetchOllamaModels", () => {
  const originalBaseUrl = config.llm.ollama.baseUrl;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    config.llm.ollama.baseUrl = "http://localhost:11434/v1";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "llama3" }] }), {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    config.llm.ollama.baseUrl = originalBaseUrl;
    vi.restoreAllMocks();
  });

  test("uses placeholder bearer when no key provided", async () => {
    await fetchOllamaModels("");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /Bearer/,
    );
  });

  test("uses provided key when set", async () => {
    await fetchOllamaModels("my-token");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer my-token",
    );
  });

  test("throws hint mentioning host.docker.internal when localhost is unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(fetchOllamaModels("", "http://localhost:11434/v1")).rejects.toThrow(
      /host\.docker\.internal/,
    );
  });

  test("throws plain connection error for remote URLs without docker hint", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    let caught: unknown;
    try {
      await fetchOllamaModels("", "https://ollama.example.com/v1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(
      /Cannot reach Ollama at https:\/\/ollama\.example\.com/,
    );
    expect(message).not.toMatch(/host\.docker\.internal/);
  });

  test("propagates HTTP error with status code", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(fetchOllamaModels("")).rejects.toThrow(
      /Failed to fetch Ollama models: 500/,
    );
  });
});
