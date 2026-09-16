import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import llmProviderModelsRoutes from "@/routes/llm-provider-models";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { modelSyncService } from "./model-sync";

describe("provider catalog arrival visibility", () => {
  const server = useMswServer();
  let organizationId: string;
  let apiKeyId: string;
  let catalog: string[];
  let app: FastifyInstanceWithZod;

  beforeEach(
    async ({
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const organization = await makeOrganization();
      await OrganizationModel.patch(organization.id, {
        modelProviderOverrides: {
          openrouter: { showNewModelsAutomatically: false },
        },
      });
      organizationId = organization.id;
      const user = await makeAdmin();
      await makeMember(user.id, organizationId, { role: "admin" });
      const secret = await makeSecret({
        secret: { apiKey: "test-provider-key" },
      });
      const key = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "openrouter",
        scope: "org",
      });
      apiKeyId = key.id;
      catalog = ["vendor/initial"];
      config.llm.openrouter.baseUrl = "https://catalog.example/api/v1";
      server.use(
        http.get("https://catalog.example/api/v1/models", () =>
          HttpResponse.json({
            data: catalog.map((id) => ({
              id,
              name: id,
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              supported_parameters: ["tools"],
            })),
          }),
        ),
        http.get("https://catalog.example/api/v1/embeddings/models", () =>
          HttpResponse.json({ data: [] }),
        ),
        http.get("https://models.dev/api.json", () => HttpResponse.json({})),
      );
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.user = user;
        request.organizationId = organizationId;
      });
      await app.register(llmProviderModelsRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const sync = (forceRefresh = false) =>
    modelSyncService.syncModelsForApiKey({
      apiKeyId,
      provider: "openrouter",
      apiKeyValue: "test-provider-key",
      forceRefresh,
    });
  const model = (id: string) =>
    ModelModel.findByProviderAndModelId("openrouter", id);

  test("manual refresh hides first catalog arrivals, including registry rows, and pickers omit them", async () => {
    await sync();
    await ModelModel.bulkUpsert([
      {
        externalId: "openrouter/vendor/registry",
        provider: "openrouter",
        modelId: "vendor/registry",
        inputModalities: null,
        outputModalities: null,
      },
    ]);
    catalog.push("vendor/new", "vendor/registry");
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-models/sync",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, failures: [] });
    expect(await model("vendor/initial")).toMatchObject({ ignored: false });
    expect(await model("vendor/new")).toMatchObject({ ignored: true });
    expect(await model("vendor/registry")).toMatchObject({ ignored: true });
    const available = await app.inject({
      method: "GET",
      url: `/api/llm-models/available?apiKeyId=${apiKeyId}`,
    });
    expect(available.statusCode).toBe(200);
    expect(available.json().map((entry: { id: string }) => entry.id)).toEqual([
      "vendor/initial",
    ]);
    const all = await app.inject({ method: "GET", url: "/api/llm-models" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: "vendor/new", ignored: true }),
      ]),
    );
  });

  test("each brand new key gets a visible initial catalog without revealing already hidden models", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await sync();
    catalog.push("vendor/hidden");
    await sync();
    catalog.push("vendor/new-key-model");
    const secret = await makeSecret({ secret: { apiKey: "new-test-key" } });
    const newKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openrouter",
      scope: "org",
    });
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: newKey.id,
      provider: "openrouter",
      apiKeyValue: "new-test-key",
    });
    expect(await model("vendor/initial")).toMatchObject({ ignored: false });
    expect(await model("vendor/new-key-model")).toMatchObject({
      ignored: false,
    });
    expect(await model("vendor/hidden")).toMatchObject({ ignored: true });
    await sync();
    expect(await model("vendor/new-key-model")).toMatchObject({
      ignored: false,
    });
  });

  test.each([
    false,
    true,
  ])("preserves Show and Hide choices on refresh (full: %s)", async (forceRefresh) => {
    await sync();
    catalog.push("vendor/shown", "vendor/stays-hidden");
    await sync();
    const shown = await model("vendor/shown");
    const hidden = await model("vendor/initial");
    expect(shown).not.toBeNull();
    expect(hidden).not.toBeNull();
    const showResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${shown?.id}`,
      payload: { ignored: false },
    });
    const hideResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${hidden?.id}`,
      payload: { ignored: true },
    });
    expect(showResponse.statusCode).toBe(200);
    expect(hideResponse.statusCode).toBe(200);
    await sync(forceRefresh);
    expect(await model("vendor/shown")).toMatchObject({ ignored: false });
    expect(await model("vendor/initial")).toMatchObject({ ignored: true });
    await OrganizationModel.patch(organizationId, {
      modelProviderOverrides: {
        openrouter: { showNewModelsAutomatically: true },
      },
    });
    catalog.push("vendor/visible-after-enabling");
    await sync(forceRefresh);
    expect(await model("vendor/shown")).toMatchObject({ ignored: false });
    expect(await model("vendor/stays-hidden")).toMatchObject({ ignored: true });
    expect(await model("vendor/visible-after-enabling")).toMatchObject({
      ignored: false,
    });
  });

  test("the default setting preserves automatic visibility", async () => {
    await OrganizationModel.patch(organizationId, {
      modelProviderOverrides: null,
    });
    await sync();
    catalog.push("vendor/new");
    await sync();
    expect(await model("vendor/new")).toMatchObject({ ignored: false });
  });

  test("picker-triggered sync after an empty first sync hides later arrivals", async () => {
    catalog = [];
    await sync();
    catalog = ["vendor/later"];
    const response = await app.inject({
      method: "GET",
      url: `/api/llm-models/available?apiKeyId=${apiKeyId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-archestra-lazy-model-sync"]).toBe("pending");
    await vi.waitFor(async () => {
      expect(
        await LlmProviderApiKeyModelLinkModel.getModelCountForApiKey(apiKeyId),
      ).toBe(1);
    });
    expect(await model("vendor/later")).toMatchObject({ ignored: true });
  });

  test("an empty refresh does not reset key or model arrival history", async () => {
    await sync();
    catalog = [];
    await sync();
    catalog = ["vendor/initial", "vendor/later"];
    await sync();
    expect(await model("vendor/initial")).toMatchObject({ ignored: false });
    expect(await model("vendor/later")).toMatchObject({ ignored: true });
  });

  test("orphan cleanup preserves Show when a model leaves and returns to a catalog", async () => {
    await sync();
    catalog.push("vendor/returning");
    await sync();
    const returning = await model("vendor/returning");
    const shown = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${returning?.id}`,
      payload: { ignored: false },
    });
    expect(shown.statusCode).toBe(200);
    catalog = ["vendor/initial"];
    await sync();
    await ModelModel.deleteOrphanedModels();
    catalog.push("vendor/returning");
    await sync();
    expect(await model("vendor/returning")).toMatchObject({
      id: returning?.id,
      ignored: false,
    });
  });

  test("a failed initial sync does not consume the new-key exemption", async () => {
    server.use(
      http.get(
        "https://catalog.example/api/v1/models",
        () => new HttpResponse(null, { status: 401 }),
        { once: true },
      ),
    );
    await expect(sync()).rejects.toThrow();
    await sync();
    expect(await model("vendor/initial")).toMatchObject({ ignored: false });
  });

  test("proxy-only discoveries remain visible and unlinked", async () => {
    await sync();
    await ModelModel.ensureModelExists("vendor/proxy-only", "openrouter");
    await sync();
    expect(await model("vendor/proxy-only")).toMatchObject({
      ignored: false,
      discoveredViaLlmProxy: true,
    });
    expect(
      await LlmProviderApiKeyModelLinkModel.getModelsForApiKey(apiKeyId),
    ).toHaveLength(1);
  });

  test.each([
    false,
    true,
  ])("proxy-first models retain visibility when later cataloged (full: %s)", async (forceRefresh) => {
    await sync();
    const discovered = await ModelModel.ensureModelExists(
      "vendor/proxy-first",
      "openrouter",
    );
    const hideResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${discovered?.id}`,
      payload: { ignored: true },
    });
    const showResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${discovered?.id}`,
      payload: { ignored: false },
    });
    expect(hideResponse.statusCode).toBe(200);
    expect(showResponse.statusCode).toBe(200);
    catalog.push("vendor/proxy-first");
    await sync(forceRefresh);
    expect(await model("vendor/proxy-first")).toMatchObject({
      ignored: false,
      discoveredViaLlmProxy: false,
    });
    await sync(forceRefresh);
    expect(await model("vendor/proxy-first")).toMatchObject({ ignored: false });
  });
});
