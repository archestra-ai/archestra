import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { fetchVllmModels } from "./vllm";

describe("fetchVllmModels", () => {
  const originalBaseUrl = config.llm.vllm.baseUrl;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    config.llm.vllm.baseUrl = "https://vllm.example.com/v1";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "llama-3" }] }), {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    config.llm.vllm.baseUrl = originalBaseUrl;
    vi.restoreAllMocks();
  });

  function lastFetchCall() {
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    return call;
  }

  test("sends bearer auth header by default", async () => {
    await fetchVllmModels("my-key");
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer my-key",
    });
  });

  test("merges per-key extraHeaders alongside bearer auth", async () => {
    await fetchVllmModels("my-key", null, {
      "kubeflow-userid": "user@example.com",
      "x-tenant-id": "acme",
    });
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toEqual({
      "kubeflow-userid": "user@example.com",
      "x-tenant-id": "acme",
      Authorization: "Bearer my-key",
    });
  });

  test("Authorization wins over a user-provided Authorization header", async () => {
    await fetchVllmModels("my-key", null, {
      Authorization: "Bearer attacker-token",
    });
    const [, init] = lastFetchCall();
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer my-key",
    });
  });

  test("uses baseUrl override when provided", async () => {
    await fetchVllmModels("k", "https://custom.example.com/v1");
    const [url] = lastFetchCall();
    expect(url).toBe("https://custom.example.com/v1/models");
  });

  test("throws on non-2xx response with status code in message", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("error: RBAC: access denied", { status: 403 }),
    );
    await expect(fetchVllmModels("k")).rejects.toThrow(
      "Failed to fetch vLLM models: 403",
    );
  });
});
