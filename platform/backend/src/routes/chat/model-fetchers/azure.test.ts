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
  getAzureManagementBearerTokenProvider: vi.fn(() => async () => "mgmt-token"),
  getAzureOpenAiBearerTokenProvider: vi.fn(() => async () => "entra-token"),
  isAzureOpenAiEntraIdEnabled: vi.fn(() => false),
}));

import {
  getAzureManagementBearerTokenProvider,
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";

const mockIsAzureOpenAiEntraIdEnabled = vi.mocked(isAzureOpenAiEntraIdEnabled);
const mockGetAzureManagementBearerTokenProvider = vi.mocked(
  getAzureManagementBearerTokenProvider,
);
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

  test("lists deployments from an Azure resource-level base URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "gpt-4o" }, { id: "text-embedding-3-large" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "test-key",
      "https://my-resource.openai.azure.com/openai",
    );

    expect(result).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: "azure" },
      {
        id: "text-embedding-3-large",
        displayName: "text-embedding-3-large",
        provider: "azure",
      },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
      { headers: { "api-key": "test-key" } },
    );

    vi.unstubAllGlobals();
  });

  test("falls back to Azure management deployments when data-plane deployment discovery is unavailable", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () =>
          '{"error":{"code":"404","message":"Resource not found"}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ subscriptionId: "sub-1" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-resource",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              name: "gpt-5.2-chat",
              properties: { provisioningState: "Succeeded" },
            },
            {
              name: "gpt-5.4-mini",
              properties: { provisioningState: "Succeeded" },
            },
            {
              name: "failed-deployment",
              properties: { provisioningState: "Failed" },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "",
      "https://my-resource.openai.azure.com/openai",
    );

    expect(result).toEqual([
      { id: "gpt-5.2-chat", displayName: "gpt-5.2-chat", provider: "azure" },
      { id: "gpt-5.4-mini", displayName: "gpt-5.4-mini", provider: "azure" },
    ]);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
      { headers: { Authorization: "Bearer entra-token" } },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        href: "https://management.azure.com/subscriptions?api-version=2020-01-01",
      }),
      { headers: { Authorization: "Bearer mgmt-token" } },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        href: "https://management.azure.com/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-resource/deployments?api-version=2024-10-01",
      }),
      { headers: { Authorization: "Bearer mgmt-token" } },
    );
    expect(mockGetAzureManagementBearerTokenProvider).toHaveBeenCalled();

    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  test("resolves a Foundry project resource to its parent Azure Cognitive Services account for deployment discovery", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () =>
          '{"error":{"code":"404","message":"Resource not found"}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ subscriptionId: "sub-1" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/parent-resource/projects/project-resource",
              name: "parent-resource/project-resource",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              name: "gpt-5.2-chat",
              properties: { provisioningState: "Succeeded" },
            },
            {
              name: "text-embedding-3-large",
              properties: { provisioningState: "Succeeded" },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "",
      "https://project-resource.openai.azure.com/openai",
    );

    expect(result).toEqual([
      { id: "gpt-5.2-chat", displayName: "gpt-5.2-chat", provider: "azure" },
      {
        id: "text-embedding-3-large",
        displayName: "text-embedding-3-large",
        provider: "azure",
      },
    ]);
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        href: "https://management.azure.com/subscriptions/sub-1/resources?api-version=2021-04-01&%24filter=resourceType+eq+%27Microsoft.CognitiveServices%2Faccounts%2Fprojects%27",
      }),
      { headers: { Authorization: "Bearer mgmt-token" } },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        href: "https://management.azure.com/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/parent-resource/deployments?api-version=2024-10-01",
      }),
      { headers: { Authorization: "Bearer mgmt-token" } },
    );

    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  test("does not fall back to resource-level model catalog when deployment discovery and management discovery are unavailable", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () =>
          '{"error":{"code":"404","message":"Resource not found"}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ subscriptionId: "sub-1" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "",
      "https://my-resource.openai.azure.com/openai",
    );

    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch).not.toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/models?api-version=2024-02-01",
      expect.any(Object),
    );

    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
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

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [{ subscriptionId: "sub-1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      })
      .mockResolvedValueOnce({
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
      {
        id: "text-embedding",
        displayName: "text-embedding",
        provider: "azure",
      },
    ]);
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      "https://my-resource.services.ai.azure.com/openai/v1/models",
      { headers: { Authorization: "Bearer entra-token" } },
    );

    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  test("lists Azure management deployments before Azure OpenAI v1 available models", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ subscriptionId: "sub-1" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-resource",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              name: "gpt-5-nano",
              properties: { provisioningState: "Succeeded" },
            },
            { name: "gpt-4.1", properties: { provisioningState: "Succeeded" } },
            {
              name: "grok-4-1-fast-non-reasoning",
              properties: { provisioningState: "Succeeded" },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "",
      "https://my-resource.services.ai.azure.com/openai/v1",
    );

    expect(result).toEqual([
      { id: "gpt-5-nano", displayName: "gpt-5-nano", provider: "azure" },
      { id: "gpt-4.1", displayName: "gpt-4.1", provider: "azure" },
      {
        id: "grok-4-1-fast-non-reasoning",
        displayName: "grok-4-1-fast-non-reasoning",
        provider: "azure",
      },
    ]);
    expect(mockFetch).not.toHaveBeenCalledWith(
      "https://my-resource.services.ai.azure.com/openai/v1/models",
      expect.any(Object),
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

  test("does not treat a resource-level /openai path as a deployment name", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () =>
        '{"error":{"code":"404","message":"Resource not found"}}',
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchAzureModels(
      "test-key",
      "https://my-resource.openai.azure.com/openai",
    );

    expect(result).toEqual([]);

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
