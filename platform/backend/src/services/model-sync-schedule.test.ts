import { TimeInMs } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import db, { schema } from "@/database";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { systemKeyManager } from "@/services/system-key-manager";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import {
  syncDueModels,
  syncModelsForVisibleApiKeys,
} from "./model-sync-schedule";

setupTestCacheManager();

describe("scheduled LLM model sync", () => {
  const server = useMswServer();
  let organizationId: string;
  let modelsDev: { requests: number; status: number };

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    modelsDevClient.clearFetchCache();
    modelsDev = { requests: 0, status: 200 };
    server.use(
      http.get("https://models.dev/api.json", () => {
        modelsDev.requests += 1;
        return modelsDev.status === 200
          ? HttpResponse.json(MODELS_DEV_RESPONSE)
          : new HttpResponse("unavailable", { status: modelsDev.status });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("models.dev metadata", () => {
    test("syncs only when it is due", async () => {
      await syncDueModels();
      expect(modelsDev.requests).toBe(1);

      modelsDevClient.clearFetchCache();
      await syncDueModels();
      expect(modelsDev.requests).toBe(1);
    });

    test("a failing models.dev does not stop key syncs, fails the tick once, and is not retried on the next tick", async ({
      makeLlmProviderApiKey,
    }) => {
      // The retry backoff waits in real time; skip the waits.
      vi.spyOn(
        modelsDevClient as unknown as { sleep: (ms: number) => Promise<void> },
        "sleep",
      ).mockResolvedValue();
      modelsDev.status = 500;
      const vllm = serveModels("vllm.test");
      const apiKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://vllm.test/v1",
      });

      // The task queue records the failed tick; the key sync still ran.
      await expect(syncDueModels()).rejects.toThrow(
        "models.dev metadata sync failed",
      );
      const failedRequests = modelsDev.requests;
      expect(failedRequests).toBeGreaterThan(0);
      expect(vllm.hits).toBe(1);
      expect(await linkedModelCount(apiKey.id)).toBe(2);

      modelsDevClient.clearFetchCache();
      await syncDueModels();
      expect(modelsDev.requests).toBe(failedRequests);
    });
  });

  describe("API keys", () => {
    beforeEach(async () => {
      await markModelsDevFresh();
    });

    test("syncs a stale key, skips a fresh one, and honors each provider's TTL", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const vllm = serveModels("vllm.test");
      const openrouter = serveModels("openrouter.test", { embeddings: true });
      const deepseek = serveModels("deepseek.test");
      const vllmKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://vllm.test/v1",
      });
      await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "openrouter",
        baseUrl: "http://openrouter.test/v1",
      });
      await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "deepseek",
        baseUrl: "http://deepseek.test/v1",
      });

      const start = new Date("2026-10-01T12:00:00.000Z");
      // Ticks land a moment after a TTL ends; the exact boundary has its own test.
      const after = (ms: number) =>
        new Date(start.getTime() + ms + TimeInMs.Second);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start);

      // Never synced: all three are fetched.
      await syncDueModels();
      expect([vllm.hits, openrouter.hits, deepseek.hits]).toEqual([1, 1, 1]);
      expect(await linkedModelCount(vllmKey.id)).toBe(2);

      // Fresh: nothing is fetched again.
      await syncDueModels();
      expect([vllm.hits, openrouter.hits, deepseek.hits]).toEqual([1, 1, 1]);

      // vLLM ages out after 5 minutes.
      vi.setSystemTime(after(5 * TimeInMs.Minute));
      await syncDueModels();
      expect([vllm.hits, openrouter.hits, deepseek.hits]).toEqual([2, 1, 1]);

      // OpenRouter after an hour.
      vi.setSystemTime(after(TimeInMs.Hour));
      await syncDueModels();
      expect([vllm.hits, openrouter.hits, deepseek.hits]).toEqual([3, 2, 1]);

      // Everything else after a day.
      vi.setSystemTime(after(TimeInMs.Day));
      await syncDueModels();
      expect([vllm.hits, openrouter.hits, deepseek.hits]).toEqual([4, 3, 2]);
    });

    test("treats a key synced exactly one TTL ago as stale", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const openrouter = serveModels("openrouter.test", { embeddings: true });
      const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "openrouter",
        baseUrl: "http://openrouter.test/v1",
      });
      const syncedAt = new Date("2026-10-01T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(syncedAt);
      await linkModels(apiKey.id, "openrouter", ["model-a"]);

      vi.setSystemTime(new Date(syncedAt.getTime() + TimeInMs.Hour - 1));
      await syncDueModels();
      expect(openrouter.hits).toBe(0);

      vi.setSystemTime(new Date(syncedAt.getTime() + TimeInMs.Hour));
      await syncDueModels();
      expect(openrouter.hits).toBe(1);
    });

    test("ages a key by its own sync, not by another key syncing the same models", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const connectedAt = new Date("2026-09-15T12:00:00.000Z");
      const now = new Date(connectedAt.getTime() + 2 * TimeInMs.Day);
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const subscription = serveModels("subscription.test");
      const metered = serveModels("metered.test");
      const subscriptionKey = await makeLlmProviderApiKey(
        organizationId,
        secret.id,
        { provider: "deepseek", baseUrl: "http://subscription.test/v1" },
      );
      const meteredKey = await makeLlmProviderApiKey(
        organizationId,
        secret.id,
        {
          provider: "deepseek",
          baseUrl: "http://metered.test/v1",
        },
      );
      const modelIds = ["deepseek-chat", "deepseek-reasoner"];

      vi.useFakeTimers({ toFake: ["Date"] });
      // The first key synced once, when it was connected...
      vi.setSystemTime(connectedAt);
      await linkModels(subscriptionKey.id, "deepseek", modelIds);
      // ...while a second key keeps syncing the very same models.
      vi.setSystemTime(now);
      await linkModels(meteredKey.id, "deepseek", modelIds);

      await syncDueModels();

      expect(subscription.hits).toBe(1);
      expect(metered.hits).toBe(0);
    });

    test("treats links without a sync time as stale", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const deepseek = serveModels("deepseek.test");
      const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "deepseek",
        baseUrl: "http://deepseek.test/v1",
      });
      await linkModels(apiKey.id, "deepseek", ["deepseek-chat"]);
      // Links written before the column existed carry no sync time. No model
      // method writes that state, so the legacy row is set up directly.
      await db
        .update(schema.llmProviderApiKeyModelsTable)
        .set({ syncedAt: null })
        .where(eq(schema.llmProviderApiKeyModelsTable.apiKeyId, apiKey.id));

      await syncDueModels();

      expect(deepseek.hits).toBe(1);
    });

    test("tries a key that lists no models once per TTL", async ({
      makeLlmProviderApiKey,
    }) => {
      const empty = serveModels("empty.test", { models: [] });
      const apiKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://empty.test/v1",
      });
      const start = new Date("2026-10-01T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start);

      await syncDueModels();
      expect(empty.hits).toBe(1);
      expect(await linkedModelCount(apiKey.id)).toBe(0);

      // No models means stale, but the attempt settles it for the TTL.
      vi.setSystemTime(new Date(start.getTime() + 4 * TimeInMs.Minute));
      await syncDueModels();
      expect(empty.hits).toBe(1);

      vi.setSystemTime(
        new Date(start.getTime() + 5 * TimeInMs.Minute + TimeInMs.Second),
      );
      await syncDueModels();
      expect(empty.hits).toBe(2);
    });

    test("does not retry a failing key before its TTL, and the failure does not block other keys", async ({
      makeLlmProviderApiKey,
    }) => {
      const down = serveModels("down.test", { status: 503 });
      const up = serveModels("up.test");
      const downKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://down.test/v1",
      });
      const upKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://up.test/v1",
      });

      const start = new Date("2026-10-01T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start);

      await syncDueModels();
      const downHitsAfterFirstTry = down.hits;
      expect(downHitsAfterFirstTry).toBeGreaterThan(0);
      expect(await linkedModelCount(downKey.id)).toBe(0);
      expect(up.hits).toBe(1);
      expect(await linkedModelCount(upKey.id)).toBe(2);

      // Still stale (no models), but tried within the TTL: left alone.
      vi.setSystemTime(new Date(start.getTime() + 4 * TimeInMs.Minute));
      await syncDueModels();
      expect(down.hits).toBe(downHitsAfterFirstTry);

      vi.setSystemTime(
        new Date(start.getTime() + 5 * TimeInMs.Minute + TimeInMs.Second),
      );
      await syncDueModels();
      expect(down.hits).toBeGreaterThan(downHitsAfterFirstTry);
      expect(up.hits).toBe(2);
    });

    test("syncs at most the cap per tick, never-synced and oldest first, and leaves the rest unmarked for the next tick", async ({
      makeLlmProviderApiKey,
    }) => {
      const neverSynced = serveModels("never.test");
      const oldest = serveModels("oldest.test");
      const older = serveModels("older.test");
      const neverSyncedKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://never.test/v1",
      });
      const olderKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://older.test/v1",
      });
      const oldestKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://oldest.test/v1",
      });
      const start = new Date("2026-10-01T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(start.getTime() - TimeInMs.Hour));
      await linkModels(oldestKey.id, "vllm", ["oldest-small"]);
      vi.setSystemTime(new Date(start.getTime() - 30 * TimeInMs.Minute));
      await linkModels(olderKey.id, "vllm", ["older-small"]);
      vi.setSystemTime(start);

      await syncDueModels({ maxKeys: 2 });
      expect([neverSynced.hits, oldest.hits, older.hits]).toEqual([1, 1, 0]);
      expect(await attemptMarker(neverSyncedKey.id)).toBe(true);
      expect(await attemptMarker(olderKey.id)).toBeUndefined();

      await syncDueModels({ maxKeys: 2 });
      expect([neverSynced.hits, oldest.hits, older.hits]).toEqual([1, 1, 1]);
    });

    test("hands system keys to the system key manager once per organization", async () => {
      config.llm.gemini.vertexAi.enabled = true;
      config.llm.bedrock.iamAuthEnabled = true;
      await LlmProviderApiKeyModel.createSystemKey({
        organizationId,
        name: "Vertex AI",
        provider: "gemini",
      });
      await LlmProviderApiKeyModel.createSystemKey({
        organizationId,
        name: "AWS Bedrock",
        provider: "bedrock",
      });
      const syncSystemKeys = vi
        .spyOn(systemKeyManager, "syncSystemKeys")
        .mockResolvedValue([]);

      await syncDueModels();
      expect(syncSystemKeys).toHaveBeenCalledTimes(1);
      expect(syncSystemKeys).toHaveBeenCalledWith(organizationId);

      // The spy linked no models, so both keys stay stale, but they were tried.
      await syncDueModels();
      expect(syncSystemKeys).toHaveBeenCalledTimes(1);
    });
  });

  describe("syncModelsForVisibleApiKeys (explicit refresh)", () => {
    let userId: string;

    beforeEach(async ({ makeUser, makeMember }) => {
      await markModelsDevFresh();
      userId = (await makeUser()).id;
      await makeMember(userId, organizationId, { role: "admin" });
    });

    test("syncs keys that are still fresh, at their own base URL, and reports failures", async ({
      makeLlmProviderApiKey,
    }) => {
      const proxy = serveModels("proxy.test");
      serveModels("down.test", { status: 503 });
      const proxyKey = await makeLlmProviderApiKey(organizationId, null, {
        provider: "vllm",
        baseUrl: "http://proxy.test/v1",
        userId,
      });
      const downKey = await makeLlmProviderApiKey(organizationId, null, {
        name: "Down",
        provider: "vllm",
        baseUrl: "http://down.test/v1",
        userId,
      });

      // The schedule syncs the key; the explicit refresh syncs it again.
      await syncDueModels();
      const failures = await syncModelsForVisibleApiKeys({
        organizationId,
        userId,
      });

      expect(proxy.hits).toBe(2);
      expect(await linkedModelCount(proxyKey.id)).toBe(2);
      expect(failures).toEqual([
        {
          apiKeyId: downKey.id,
          name: "Down",
          provider: "vllm",
          requiresReauthentication: false,
        },
      ]);
    });

    test("skips a provider that needs a key when its secret cannot be resolved", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      // A secret without an `apiKey` value resolves to nothing.
      const secret = await makeSecret();
      const deepseek = serveModels("deepseek.test");
      const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
        name: "No credential",
        provider: "deepseek",
        baseUrl: "http://deepseek.test/v1",
        userId,
      });

      const failures = await syncModelsForVisibleApiKeys({
        organizationId,
        userId,
      });

      expect(deepseek.hits).toBe(0);
      expect(failures).toEqual([
        {
          apiKeyId: apiKey.id,
          name: "No credential",
          provider: "deepseek",
          requiresReauthentication: false,
        },
      ]);
    });

    test("delegates Vertex AI system keys to the system key sync", async () => {
      config.llm.gemini.vertexAi.enabled = true;
      await LlmProviderApiKeyModel.createSystemKey({
        organizationId,
        name: "Vertex AI",
        provider: "gemini",
      });
      const syncSystemKeys = vi
        .spyOn(systemKeyManager, "syncSystemKeys")
        .mockResolvedValue([]);

      const failures = await syncModelsForVisibleApiKeys({
        organizationId,
        userId,
      });

      expect(syncSystemKeys).toHaveBeenCalledWith(organizationId);
      expect(failures).toEqual([]);
    });
  });

  function serveModels(
    host: string,
    options: { status?: number; embeddings?: boolean; models?: string[] } = {},
  ) {
    const counter = { hits: 0 };
    const modelIds = options.models ?? [`${host}-small`, `${host}-large`];
    server.use(
      http.get(`http://${host}/v1/models`, () => {
        counter.hits += 1;
        if (options.status) {
          return new HttpResponse("unavailable", { status: options.status });
        }
        return HttpResponse.json({
          object: "list",
          data: modelIds.map((id) => ({ id })),
        });
      }),
    );
    if (options.embeddings) {
      server.use(
        http.get(`http://${host}/v1/embeddings/models`, () =>
          HttpResponse.json({ data: [] }),
        ),
      );
    }
    return counter;
  }

  async function markModelsDevFresh() {
    await modelsDevClient.syncIfNeeded();
    modelsDev.requests = 0;
  }
});

async function linkModels(
  apiKeyId: string,
  provider: "deepseek" | "openrouter" | "vllm",
  modelIds: string[],
) {
  const models = [];
  for (const modelId of modelIds) {
    models.push(
      (await ModelModel.findByProviderAndModelId(provider, modelId)) ??
        (await ModelModel.create({
          externalId: `${provider}/${modelId}`,
          provider,
          modelId,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalling: true,
          lastSyncedAt: new Date(),
        })),
    );
  }
  await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
    apiKeyId,
    models.map((model) => ({ id: model.id, modelId: model.modelId })),
    provider,
  );
}

async function linkedModelCount(apiKeyId: string): Promise<number> {
  return LlmProviderApiKeyModelLinkModel.getModelCountForApiKey(apiKeyId);
}

async function attemptMarker(apiKeyId: string): Promise<true | undefined> {
  return cacheManager.get<true>(`llm-model-sync-attempt-${apiKeyId}`);
}

const MODELS_DEV_RESPONSE = {
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    doc: "https://platform.openai.com/docs",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt",
        attachment: true,
        reasoning: false,
        tool_call: true,
        structured_output: true,
        temperature: true,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 2.5, output: 10 },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
};
