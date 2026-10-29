import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { createLLMModelForAgent } from "@/clients/llm-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { getAvailableLlmModels } from "@/routes/llm-provider-models";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  resolveAzureModelCapabilities,
  validateAzureModelOperation,
} from "./azure-model-capabilities";
import { modelSyncService } from "./model-sync";

const baseUrl = "https://scope5.openai.azure.com/openai";
const secondUrl = "https://scope5-b.openai.azure.com/openai";
let backing: string | undefined = "gpt-image-1";
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const server = useMswServer(
  http.get("https://models.dev/api.json", () => HttpResponse.json({})),
  http.get(`${baseUrl}/deployments`, () =>
    HttpResponse.json({
      data: [{ id: "production", ...(backing ? { model: backing } : {}) }],
    }),
  ),
  http.get(`${secondUrl}/deployments`, () =>
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
  test.for([
    {
      backing: "dall-e-3",
      parameters: { response_format: "url", style: "natural", n: 1 },
      valid: true,
    },
    { backing: "dall-e-3", parameters: { n: 2 }, valid: false },
    { backing: "dall-e-2", parameters: { style: "natural" }, valid: false },
    {
      backing: "gpt-image-1",
      parameters: { response_format: "b64_json" },
      valid: false,
    },
    { backing: "gpt-image-1", parameters: { quality: "xhigh" }, valid: false },
    { backing: "gpt-image-1", parameters: { size: "1536x864" }, valid: false },
    { backing: "gpt-image-2", parameters: { quality: "xhigh" }, valid: false },
    { backing: "gpt-image-2", parameters: { size: "1536x864" }, valid: true },
    {
      backing: "gpt-image-2.5-sunburst-2026-09-08",
      parameters: {
        quality: "max",
        size: "1536x864",
        safety_identifier: "synthetic-user",
      },
      valid: true,
    },
    {
      backing: "gpt-image-2.5-flare",
      parameters: { quality: "xhigh" },
      valid: true,
    },
  ])("validates image fields against backing evidence: %j", async (example, {
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    backing = example.backing;
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
    const result = validateAzureModelOperation({
      providerApiKeyId: key.id,
      modelId: "production",
      operation: "image-generation",
      parameters: example.parameters,
    });
    if (example.valid)
      expect(await result).toMatchObject({ status: "known", kind: "image" });
    else await expect(result).rejects.toMatchObject({ statusCode: 400 });
  });
  test.for([
    { mime_type: "image/png", bytes: 1024, width: 16, height: 16, valid: true },
    {
      mime_type: "image/jpeg",
      bytes: 1024,
      width: 16,
      height: 16,
      valid: false,
    },
    {
      mime_type: "image/png",
      bytes: 4194304,
      width: 16,
      height: 16,
      valid: false,
    },
    {
      mime_type: "image/png",
      bytes: 1024,
      width: 16,
      height: 32,
      valid: false,
    },
    {
      mime_type: "image/png",
      bytes: 1024,
      width: undefined,
      height: undefined,
      valid: false,
    },
  ])("DALL-E 2 edit constraints use validated file metadata: %j", async (image, {
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    backing = "dall-e-2";
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
    const validate = (images: unknown[]) =>
      validateAzureModelOperation({
        providerApiKeyId: key.id,
        modelId: "production",
        operation: "image-edit",
        parameters: { input_files: { images } },
      });
    if (image.valid)
      expect(await validate([image])).toMatchObject({
        status: "known",
        kind: "image",
      });
    else
      await expect(validate([image])).rejects.toMatchObject({
        statusCode: 400,
      });
    await expect(validate([image, image])).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("explicit deployment flags classify missing backing names without trusting aliases", async ({
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
    server.use(
      http.get(`${baseUrl}/deployments`, () =>
        HttpResponse.json({
          data: [
            {
              id: "gpt-image-misleading-name",
              capabilities: { chat_completion: true },
            },
            { id: "opaque-image", capabilities: { image_generation: true } },
            { id: "gpt-audio-misleading-name" },
          ],
        }),
      ),
    );
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "azure",
      apiKeyValue: "synthetic-key",
      baseUrl,
    });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: key.id,
        modelId: "gpt-image-misleading-name",
      }),
    ).toMatchObject({ status: "known", kind: "text" });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: key.id,
        modelId: "opaque-image",
      }),
    ).toMatchObject({
      status: "known",
      kind: "image",
      operations: ["image-generation"],
    });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: key.id,
        modelId: "gpt-audio-misleading-name",
      }),
    ).toMatchObject({ status: "unknown" });
  });
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
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const a = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl,
    });
    const b = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl: secondUrl,
    });
    const sync = (key: typeof a) =>
      modelSyncService.syncModelsForApiKey({
        apiKeyId: key.id,
        provider: "azure",
        apiKeyValue: "synthetic-key",
        baseUrl: key.baseUrl,
      });
    await sync(a);
    backing = "gpt-audio";
    await sync(b);
    const list = (apiKeyId?: string) =>
      getAvailableLlmModels({
        userId: user.id,
        organizationId: org.id,
        query: { provider: "azure", apiKeyId },
      });
    expect(
      (await list(a.id)).find((model) => model.id === "production")
        ?.capabilities?.outputModalities,
    ).toEqual(["image"]);
    expect(
      (await list(b.id)).find((model) => model.id === "production")
        ?.capabilities?.outputModalities,
    ).toEqual(["text", "audio"]);
    expect(
      (await list()).find((model) => model.id === "production")?.capabilities
        ?.outputModalities,
    ).toBeNull();
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
    const links =
      await LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels([
        a.id,
        b.id,
      ]);
    for (const link of links) {
      const capabilities = ModelModel.toCapabilities({
        ...link.model,
        azureCapabilities: link.evidence,
      });
      expect(capabilities.outputModalities).toEqual(
        link.apiKeyId === a.id ? ["image"] : ["text", "audio"],
      );
    }
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
    const [imageLink] =
      await LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels([
        a.id,
      ]);
    expect(
      ModelModel.toCapabilities({
        ...imageLink.model,
        azureCapabilities: imageLink.evidence,
      }).outputModalities,
    ).toEqual(["image"]);
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

  test.for([
    true,
    false,
  ])("an in-flight refresh cannot overwrite evidence after a connection change (nonempty: %s)", async (nonempty, {
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
    const sync = () =>
      modelSyncService.syncModelsForApiKey({
        apiKeyId: key.id,
        provider: "azure",
        apiKeyValue: "synthetic-key",
        baseUrl,
      });
    await sync();
    let release = () => {};
    let started = () => {};
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${baseUrl}/deployments`, async () => {
        started();
        await barrier;
        return HttpResponse.json({
          data: nonempty ? [{ id: "production", model: "gpt-audio" }] : [],
        });
      }),
    );
    const pending = sync();
    await began;
    try {
      await LlmProviderApiKeyModel.update(key.id, { baseUrl: secondUrl });
    } finally {
      release();
    }
    await pending;
    const [link] =
      await LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels([
        key.id,
      ]);
    expect(link.evidence?.kind).toBe("image");
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: key.id,
        modelId: "production",
      }),
    ).toMatchObject({ status: "stale" });
  });

  test("a regional model catalog does not attest a deployment on this resource", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      baseUrl: `${baseUrl}/v1`,
    });
    server.use(
      http.get(`${baseUrl}/deployments`, () =>
        HttpResponse.json({}, { status: 404 }),
      ),
      http.get(`${baseUrl}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "gpt-image-1" }] }),
      ),
    );
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "azure",
      apiKeyValue: "synthetic-key",
      baseUrl: `${baseUrl}/v1`,
    });
    expect(
      await resolveAzureModelCapabilities({
        providerApiKeyId: key.id,
        modelId: "gpt-image-1",
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
