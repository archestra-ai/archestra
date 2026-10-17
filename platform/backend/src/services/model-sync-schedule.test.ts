import { TimeInMs } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { afterEach, vi } from "vitest";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
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
  let modelsDevRequests: number;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    modelsDevClient.clearFetchCache();
    modelsDevRequests = 0;
    server.use(
      http.get("https://models.dev/api.json", () => {
        modelsDevRequests += 1;
        return HttpResponse.json(MODELS_DEV_RESPONSE);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("syncs models.dev metadata only when it is due", async () => {
    await syncDueModels();
    expect(modelsDevRequests).toBe(1);

    modelsDevClient.clearFetchCache();
    await syncDueModels();
    expect(modelsDevRequests).toBe(1);
  });

  test("syncs a stale key, skips a fresh one, and honors each provider's TTL", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await markModelsDevFresh();
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const vllm = serveModels("vllm.test");
    const openrouter = serveModels("openrouter.test", {
      embeddings: true,
    });
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
    // Ticks land a moment after a TTL ends, never exactly on it.
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

  test("does not retry a failing key before its TTL, and the failure does not block other keys", async ({
    makeLlmProviderApiKey,
  }) => {
    await markModelsDevFresh();
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

  test("hands system keys to the system key manager once per organization", async () => {
    await markModelsDevFresh();
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

  test("syncModelsForVisibleApiKeys syncs now and reports failed keys", async ({
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    await markModelsDevFresh();
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });
    const up = serveModels("up.test");
    serveModels("down.test", { status: 503 });
    const upKey = await makeLlmProviderApiKey(organizationId, null, {
      provider: "vllm",
      baseUrl: "http://up.test/v1",
      userId: user.id,
    });
    const downKey = await makeLlmProviderApiKey(organizationId, null, {
      name: "Down",
      provider: "vllm",
      baseUrl: "http://down.test/v1",
      userId: user.id,
    });

    // A key synced moments ago is still synced again: this is the explicit
    // refresh, not the schedule.
    await syncDueModels();
    const failures = await syncModelsForVisibleApiKeys({
      organizationId,
      userId: user.id,
    });

    expect(up.hits).toBe(2);
    expect(await linkedModelCount(upKey.id)).toBe(2);
    expect(failures).toEqual([
      {
        apiKeyId: downKey.id,
        name: "Down",
        provider: "vllm",
        requiresReauthentication: false,
      },
    ]);
  });

  function serveModels(
    host: string,
    options: { status?: number; embeddings?: boolean } = {},
  ) {
    const counter = { hits: 0 };
    server.use(
      http.get(`http://${host}/v1/models`, () => {
        counter.hits += 1;
        if (options.status) {
          return new HttpResponse("unavailable", { status: options.status });
        }
        return HttpResponse.json({
          object: "list",
          data: [{ id: `${host}-small` }, { id: `${host}-large` }],
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
    modelsDevRequests = 0;
  }
});

async function linkedModelCount(apiKeyId: string): Promise<number> {
  const states =
    await LlmProviderApiKeyModelLinkModel.getModelSyncStatesForApiKeys([
      apiKeyId,
    ]);
  return states.get(apiKeyId)?.linkedModelCount ?? 0;
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
