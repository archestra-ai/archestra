import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { createLLMModelForAgent } from "@/clients/llm-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  resolveAzureModelCapabilities,
  validateAzureModelOperation,
} from "./azure-model-capabilities";
import { modelSyncService } from "./model-sync";

const baseUrl = "https://scope5.openai.azure.com/openai";
let backing: string | undefined = "gpt-image-1";
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const server = useMswServer(
  http.get("https://models.dev/api.json", () => HttpResponse.json({})),
  http.get(`${baseUrl}/deployments`, () =>
    HttpResponse.json({
      data: [{ id: "production", ...(backing ? { model: backing } : {}) }],
    }),
  ),
);
beforeEach(() => {
  backing = "gpt-image-1";
  modelsDevClient.clearFetchCache();
});

describe("Azure resource capability evidence", () => {
  test("a discovered image alias selects the native Chat media model", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl,
    });
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "azure",
      apiKeyValue: "synthetic-key",
      baseUrl,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      llmApiKeyId: key.id,
    });
    const resolved = await createLLMModelForAgent({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      model: "production",
      provider: "azure",
      agentLlmApiKeyId: key.id,
    });
    expect((resolved.model as { provider: string }).provider).toBe(
      "azure.media",
    );
  });

  test("same alias on different resources remains isolated through refresh and manual metadata", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const a = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl,
    });
    const b = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl,
    });
    const sync = (key: typeof a) =>
      modelSyncService.syncModelsForApiKey({
        apiKeyId: key.id,
        provider: "azure",
        apiKeyValue: "synthetic-key",
        baseUrl,
      });
    await sync(a);
    backing = "gpt-audio";
    await sync(b);
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: a.id,
        modelId: "production",
      }),
    ).toMatchObject({ status: "known", kind: "image" });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: b.id,
        modelId: "production",
      }),
    ).toMatchObject({ status: "known", kind: "audio" });
    const model = await ModelModel.findByProviderAndModelId(
      "azure",
      "production",
    );
    if (!model) throw new Error("Missing synced model");
    await ModelModel.update(model.id, {
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: a.id,
        modelId: "production",
      }),
    ).toMatchObject({ kind: "image" });
    backing = "gpt-realtime";
    await sync(a);
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: a.id,
        modelId: "production",
      }),
    ).toMatchObject({ kind: "realtime" });
    backing = undefined;
    await sync(a);
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: a.id,
        modelId: "production",
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: b.id,
        modelId: "production",
      }),
    ).toMatchObject({ kind: "audio" });
  });

  test("expired evidence and regional catalogs cannot select a transport", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl,
    });
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "azure",
      apiKeyValue: "synthetic-key",
      baseUrl,
    });
    const originalNow = Date.now();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(originalNow + 2 * 24 * 60 * 60 * 1000);
    try {
      expect(
        await resolveAzureModelCapabilities({
          providerApiKeyId: key.id,
          modelId: "production",
        }),
      ).toMatchObject({ status: "stale" });
    } finally {
      clock.mockRestore();
    }
    server.use(
      http.get(`${baseUrl}/deployments`, () =>
        HttpResponse.json({ data: [{ id: "production" }] }),
      ),
    );
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "azure",
      apiKeyValue: "synthetic-key",
      baseUrl,
      forceRefresh: true,
    });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: key.id,
        modelId: "production",
      }),
    ).toMatchObject({ status: "unknown" });
  });

  test("configuration changes invalidate evidence and explicit endpoints defer unknown metadata", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl,
    });
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "azure",
      apiKeyValue: "synthetic-key",
      baseUrl,
    });
    await expect(
      validateAzureModelOperation({
        providerApiKeyId: key.id,
        modelId: "production",
        operation: "image-generation",
        parameters: { response_format: "b64_json" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      validateAzureModelOperation({
        providerApiKeyId: key.id,
        modelId: "production",
        operation: "chat",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await LlmProviderApiKeyModel.update(key.id, {
      baseUrl: "https://other.openai.azure.com/openai",
    });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: key.id,
        modelId: "production",
      }),
    ).toMatchObject({ status: "stale" });
    expect(
      await validateAzureModelOperation({
        providerApiKeyId: key.id,
        modelId: "unseen",
        operation: "image-generation",
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      await LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels([]),
    ).toEqual([]);
  });
});
