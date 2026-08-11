import { vi } from "vitest";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import { beforeEach, describe, expect, test } from "@/test";
import { testProviderApiKey } from "./registry";

const mockFetch = vi.fn();
// The shared test setup restores the real fetch after every test, so
// re-apply the mock before each one.
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

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
    await testProviderApiKey({
      provider: "openai",
      apiKey: "test-key",
      baseUrl: customBaseUrl,
    });

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

    await testProviderApiKey({
      provider: "openai",
      apiKey: "test-key",
      baseUrl: "https://gateway.example.com/v1",
      extraHeaders: { "kubeflow-userid": "user@example.com" },
    });

    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer test-key",
      "kubeflow-userid": "user@example.com",
    });
  });

  test("rejects a foreign subscription marker before the provider fetcher", async () => {
    const xaiCredential = encodeXaiSubscriptionCredential({
      refreshToken: "rt-never-forward",
      userId: "x-user",
    });

    await expect(
      testProviderApiKey({
        provider: "openai",
        apiKey: xaiCredential,
        baseUrl: "https://attacker.example/v1",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
