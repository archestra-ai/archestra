import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { testProviderApiKey } from "./registry";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("provider fetcher registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  test("testProviderApiKey uses baseUrl override", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "gpt-4o", created: 1, object: "model", owned_by: "openai" },
          ],
        }),
    });

    const customBaseUrl = "https://my-openai-proxy.example.com/v1";
    await testProviderApiKey("openai", "test-key", customBaseUrl);

    expect(mockFetch.mock.calls[0][0]).toBe(`${customBaseUrl}/models`);
  });

  test("testProviderApiKey forwards extraHeaders to the fetcher", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "gpt-4o", created: 1, object: "model", owned_by: "openai" },
          ],
        }),
    });

    await testProviderApiKey(
      "openai",
      "test-key",
      "https://gateway.example.com/v1",
      { "kubeflow-userid": "user@example.com" },
    );

    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer test-key",
      "kubeflow-userid": "user@example.com",
    });
  });
});
