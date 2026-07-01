import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/clients/anthropic-workload-identity", () => ({
  anthropicWorkloadIdentity: {
    isEnabled: vi.fn(() => false),
    getAccessToken: vi.fn(async () => "sk-ant-oat01-test"),
  },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
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

import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import { fetchAnthropicModels } from "./anthropic";

const mockWifIsEnabled = vi.mocked(anthropicWorkloadIdentity.isEnabled);

const MODELS_RESPONSE = new Response(
  JSON.stringify({
    data: [
      {
        id: "claude-sonnet-4-5",
        display_name: "Claude Sonnet 4.5",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  }),
  { status: 200 },
);

describe("fetchAnthropicModels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockWifIsEnabled.mockReturnValue(false);
  });

  test("uses a federated bearer token for keyless fetches when WIF is enabled", async () => {
    mockWifIsEnabled.mockReturnValue(true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(MODELS_RESPONSE.clone());

    await expect(fetchAnthropicModels("")).resolves.toMatchObject([
      {
        id: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        headers: {
          Authorization: "Bearer sk-ant-oat01-test",
          "anthropic-version": "2023-06-01",
        },
      },
    );
  });

  test("an explicit API key takes precedence over WIF", async () => {
    mockWifIsEnabled.mockReturnValue(true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(MODELS_RESPONSE.clone());

    await fetchAnthropicModels("sk-ant-explicit");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        headers: {
          "x-api-key": "sk-ant-explicit",
          "anthropic-version": "2023-06-01",
        },
      },
    );
  });

  test("falls back to an empty x-api-key when no auth method is available", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(MODELS_RESPONSE.clone());

    await fetchAnthropicModels("");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        headers: {
          "x-api-key": "",
          "anthropic-version": "2023-06-01",
        },
      },
    );
  });
});
