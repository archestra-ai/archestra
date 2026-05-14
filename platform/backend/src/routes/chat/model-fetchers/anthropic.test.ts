import { describe, expect, test, vi } from "vitest";

const {
  mockGetAnthropicWorkloadIdentityBearerTokenProvider,
  mockGetAzureAiFoundryBearerTokenProvider,
  mockIsAnthropicAzureFoundryEntraIdEnabled,
  mockIsAnthropicWorkloadIdentityEnabled,
} = vi.hoisted(() => ({
  mockGetAnthropicWorkloadIdentityBearerTokenProvider: vi.fn(
    () => async () => "anthropic-wif-token",
  ),
  mockGetAzureAiFoundryBearerTokenProvider: vi.fn(
    () => async () => "azure-foundry-token",
  ),
  mockIsAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
  mockIsAnthropicWorkloadIdentityEnabled: vi.fn(() => false),
}));

vi.mock("@/config", () => ({
  default: {
    llm: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
      },
    },
  },
}));

vi.mock("@/logging", () => ({
  default: {
    error: vi.fn(),
  },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider:
    mockGetAzureAiFoundryBearerTokenProvider,
  isAnthropicAzureFoundryEntraIdEnabled:
    mockIsAnthropicAzureFoundryEntraIdEnabled,
}));

vi.mock("@/clients/anthropic-workload-identity", () => ({
  getAnthropicWorkloadIdentityBearerTokenProvider:
    mockGetAnthropicWorkloadIdentityBearerTokenProvider,
  isAnthropicWorkloadIdentityEnabled: mockIsAnthropicWorkloadIdentityEnabled,
}));

import { fetchAnthropicModels } from "./anthropic";

describe("fetchAnthropicModels", () => {
  test("uses an API key when one is provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createModelsResponse());

    await fetchAnthropicModels("sk-ant-api-key");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant-api-key");
    expect(headers.get("Authorization")).toBeNull();

    fetchMock.mockRestore();
  });

  test("uses Anthropic WIF bearer auth for keyless model discovery", async () => {
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createModelsResponse());

    await fetchAnthropicModels("");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer anthropic-wif-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(
      mockGetAnthropicWorkloadIdentityBearerTokenProvider,
    ).toHaveBeenCalledWith("https://api.anthropic.com");

    fetchMock.mockRestore();
  });
});

function createModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: "claude-sonnet-4-5-20250929",
          display_name: "Claude Sonnet 4.5",
          created_at: "2025-09-29T00:00:00Z",
        },
      ],
    }),
    { status: 200 },
  );
}
