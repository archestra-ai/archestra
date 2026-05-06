import { describe, expect, test, vi } from "vitest";
import { fetchAzureModels } from "./azure";

vi.mock("@/config", () => ({
  default: {
    llm: {
      azure: {
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        apiVersion: "2024-02-01",
      },
    },
  },
}));

vi.mock("@/logging", () => ({
  default: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureOpenAiBearerTokenProvider: vi.fn(() => async () => "entra-token"),
  isAzureOpenAiEntraIdEnabled: vi.fn(() => false),
}));

import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";

const mockIsAzureOpenAiEntraIdEnabled = vi.mocked(isAzureOpenAiEntraIdEnabled);
const mockGetAzureOpenAiBearerTokenProvider = vi.mocked(
  getAzureOpenAiBearerTokenProvider,
);

describe("fetchAzureModels", () => {
  test("returns empty array when baseUrl is empty and no override", async () => {
    const result = await fetchAzureModels("test-key", null);
    expect(result).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: "azure" },
    ]);
  });

  test("returns empty array when baseUrl override is only whitespace", async () => {
    const result = await fetchAzureModels("test-key", "   ");
    expect(result).toEqual([]);
  });

  test("returns empty array when endpoint regex fails", async () => {
    const result = await fetchAzureModels("test-key", "not-a-valid-url");
    expect(result).toEqual([]);
  });

  test("returns models from successful response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "test-key",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );

    expect(result).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: "azure" },
      { id: "gpt-4o-mini", displayName: "gpt-4o-mini", provider: "azure" },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
      { headers: { "api-key": "test-key" } },
    );

    vi.unstubAllGlobals();
  });

  test("strips a Bearer prefix before sending the api-key header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchAzureModels(
      "Bearer test-key",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
      { headers: { "api-key": "test-key" } },
    );

    vi.unstubAllGlobals();
  });

  test("uses Entra ID bearer token auth when enabled and no API key is provided", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchAzureModels(
      "",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
      { headers: { Authorization: "Bearer entra-token" } },
    );
    expect(mockGetAzureOpenAiBearerTokenProvider).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );

    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  test("lists chat models from Azure OpenAI v1 model endpoint", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-4.1", capabilities: { chat_completion: true } },
          { id: "grok-3", capabilities: { chat_completion: true } },
          { id: "text-embedding", capabilities: { chat_completion: false } },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "",
      "https://my-resource.services.ai.azure.com/openai/v1",
    );

    expect(result).toEqual([
      { id: "gpt-4.1", displayName: "gpt-4.1", provider: "azure" },
      { id: "grok-3", displayName: "grok-3", provider: "azure" },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.services.ai.azure.com/openai/v1/models",
      { headers: { Authorization: "Bearer entra-token" } },
    );

    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  test("returns empty array when response is not ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "bad-key",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );
    expect(result).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: "azure" },
    ]);

    vi.unstubAllGlobals();
  });

  test("returns empty array when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "test-key",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );
    expect(result).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: "azure" },
    ]);

    vi.unstubAllGlobals();
  });

  test("handles empty data array in response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "test-key",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );
    expect(result).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: "azure" },
    ]);

    vi.unstubAllGlobals();
  });

  test("handles missing data field in response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "test-key",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    );
    expect(result).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: "azure" },
    ]);

    vi.unstubAllGlobals();
  });

  test("falls back to the configured deployment name when Azure discovery returns 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () =>
        '{"error":{"code":"404","message":"Resource not found"}}',
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "test-key",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-5.2-chat",
    );

    expect(result).toEqual([
      {
        id: "gpt-5.2-chat",
        displayName: "gpt-5.2-chat",
        provider: "azure",
      },
    ]);

    vi.unstubAllGlobals();
  });

  test("extracts endpoint correctly from deployment URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchAzureModels(
      "test-key",
      "https://my-company.openai.azure.com/openai/deployments/my-gpt4-deployment",
    );

    // Should call the endpoint without the deployment name
    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-company.openai.azure.com/openai/deployments?api-version=2024-02-01",
      expect.any(Object),
    );

    vi.unstubAllGlobals();
  });

  test("builds deployments URL from a localhost wiremock deployment base URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchAzureModels(
      "test-key",
      "http://localhost:9092/azure/openai/deployments/test-deployment",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9092/azure/openai/deployments?api-version=2024-02-01",
      expect.any(Object),
    );

    vi.unstubAllGlobals();
  });
});
