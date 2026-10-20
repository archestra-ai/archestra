import { beforeEach, vi } from "vitest";

vi.mock("@/clients/anthropic-keyless-auth", () => ({
  isAnthropicKeylessAuthEnabled: vi.fn(),
}));
vi.mock("@/clients/anthropic-vertex", () => ({
  anthropicVertexClient: { isEnabled: vi.fn() },
}));
vi.mock("@/clients/anthropic-workload-identity", () => ({
  anthropicWorkloadIdentity: { isEnabled: vi.fn() },
}));
vi.mock("@/clients/azure-openai-credentials", () => ({
  isAzureOpenAiEntraIdEnabled: vi.fn(),
}));
vi.mock("@/clients/bedrock-credentials", () => ({
  isBedrockIamAuthEnabled: vi.fn(),
}));
vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(),
}));
vi.mock("@/routes/chat/model-fetchers/anthropic", () => ({
  fetchAnthropicModels: vi.fn(),
  fetchAnthropicModelsViaVertexAi: vi.fn(),
}));
vi.mock("@/routes/chat/model-fetchers/azure", () => ({
  fetchAzureModels: vi.fn(),
}));
vi.mock("@/routes/chat/model-fetchers/bedrock", () => ({
  fetchBedrockModels: vi.fn(),
  fetchBedrockModelsViaIam: vi.fn(),
}));
vi.mock("@/routes/chat/model-fetchers/gemini", () => ({
  fetchGeminiModels: vi.fn(),
  fetchGeminiModelsViaVertexAi: vi.fn(),
}));

import { HttpResponse, http } from "msw";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { anthropicVertexClient } from "@/clients/anthropic-vertex";
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
} from "@/models";
import {
  fetchAnthropicModels,
  fetchAnthropicModelsViaVertexAi,
} from "@/routes/chat/model-fetchers/anthropic";
import { fetchAzureModels } from "@/routes/chat/model-fetchers/azure";
import { fetchBedrockModelsViaIam } from "@/routes/chat/model-fetchers/bedrock";
import { fetchGeminiModelsViaVertexAi } from "@/routes/chat/model-fetchers/gemini";
import { systemKeyManager } from "@/services/system-key-manager";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

describe("systemKeyManager", () => {
  useMswServer(
    http.get("https://models.dev/api.json", () => HttpResponse.json({})),
  );

  beforeEach(() => {
    modelsDevClient.clearFetchCache();
    vi.mocked(isVertexAiEnabled).mockReturnValue(true);
    vi.mocked(isAnthropicKeylessAuthEnabled).mockReturnValue(true);
    vi.mocked(anthropicVertexClient.isEnabled).mockReturnValue(true);
    vi.mocked(anthropicWorkloadIdentity.isEnabled).mockReturnValue(false);
    vi.mocked(isAzureOpenAiEntraIdEnabled).mockReturnValue(false);
    vi.mocked(isBedrockIamAuthEnabled).mockReturnValue(false);
    vi.mocked(fetchGeminiModelsViaVertexAi).mockResolvedValue([]);
    vi.mocked(fetchAnthropicModelsViaVertexAi).mockResolvedValue([]);
    vi.mocked(fetchAnthropicModels).mockResolvedValue([]);
    vi.mocked(fetchAzureModels).mockResolvedValue([]);
    vi.mocked(fetchBedrockModelsViaIam).mockResolvedValue([]);
  });

  test("reports failed providers while continuing to sync healthy system keys", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    vi.mocked(fetchGeminiModelsViaVertexAi).mockRejectedValueOnce(
      new Error("Provider unavailable"),
    );
    expect(await systemKeyManager.syncSystemKeys(organization.id)).toEqual([
      "gemini",
    ]);
    expect(
      await LlmProviderApiKeyModel.findSystemKey("anthropic"),
    ).not.toBeNull();
    expect(await systemKeyManager.syncSystemKeys(organization.id)).toEqual([]);
  });

  test("keeps a system key's models when its model fetch fails", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    vi.mocked(fetchGeminiModelsViaVertexAi).mockResolvedValue([
      {
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        provider: "gemini",
      },
    ]);
    await systemKeyManager.syncSystemKeys(organization.id);
    const geminiKey = await LlmProviderApiKeyModel.findSystemKey("gemini");
    if (!geminiKey) throw new Error("expected a Vertex AI (Gemini) system key");
    const linkedModelIds = async () =>
      (
        await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([
          geminiKey.id,
        ])
      ).map(({ model }) => model.modelId);
    expect(await linkedModelIds()).toEqual(["gemini-2.5-flash"]);

    // Connected clients build their Gemini provider from these links, so an
    // outage must not unlink them.
    vi.mocked(fetchGeminiModelsViaVertexAi).mockRejectedValueOnce(
      new Error("PERMISSION_DENIED"),
    );
    expect(await systemKeyManager.syncSystemKeys(organization.id)).toEqual([
      "gemini",
    ]);
    expect(await linkedModelIds()).toEqual(["gemini-2.5-flash"]);
  });

  test("renames existing Vertex system keys to identify their model provider", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const geminiKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId: organization.id,
      name: "Vertex AI",
      provider: "gemini",
    });
    const anthropicKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId: organization.id,
      name: "Anthropic Vertex AI",
      provider: "anthropic",
    });

    await systemKeyManager.syncSystemKeys(organization.id);

    await expect(
      LlmProviderApiKeyModel.findSystemKey("gemini"),
    ).resolves.toMatchObject({
      id: geminiKey.id,
      name: "Vertex AI (Gemini)",
    });
    await expect(
      LlmProviderApiKeyModel.findSystemKey("anthropic"),
    ).resolves.toMatchObject({
      id: anthropicKey.id,
      name: "Vertex AI (Anthropic)",
    });
  });
});
