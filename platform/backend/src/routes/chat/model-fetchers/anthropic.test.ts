import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/clients/anthropic-workload-identity", () => ({
  ANTHROPIC_WORKLOAD_IDENTITY_MARKER:
    "__archestra_anthropic_workload_identity__",
  getAnthropicWorkloadIdentityAccessToken: vi.fn(
    async () => "sk-ant-oat01-test",
  ),
  hasAnthropicSdkStaticCredentialsConfigured: vi.fn(() => false),
  isAnthropicWorkloadIdentityConfigured: vi.fn(() => false),
  isAnthropicWorkloadIdentityMarker: vi.fn(
    (value: string | undefined) =>
      value === "__archestra_anthropic_workload_identity__",
  ),
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

import {
  ANTHROPIC_WORKLOAD_IDENTITY_MARKER,
  getAnthropicWorkloadIdentityAccessToken,
} from "@/clients/anthropic-workload-identity";
import { fetchAnthropicModels } from "./anthropic";

describe("fetchAnthropicModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("uses explicit workload identity marker to exchange a bearer token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
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
      ),
    );

    await expect(
      fetchAnthropicModels(
        ANTHROPIC_WORKLOAD_IDENTITY_MARKER,
        "https://api.anthropic.com",
      ),
    ).resolves.toMatchObject([
      {
        id: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
    ]);

    expect(getAnthropicWorkloadIdentityAccessToken).toHaveBeenCalledWith(
      "https://api.anthropic.com",
      ANTHROPIC_WORKLOAD_IDENTITY_MARKER,
    );
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
});
