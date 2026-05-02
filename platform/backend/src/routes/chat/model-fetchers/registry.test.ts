import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { fetchModelsForProvider, testProviderApiKey } from "./registry";

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("@/clients/gemini-client", () => ({
  createGoogleGenAIClient: vi.fn(),
  isVertexAiEnabled: vi.fn(),
}));

vi.mock("@/clients/bedrock-credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/bedrock-credentials")>();
  return {
    ...actual,
    isBedrockIamAuthEnabled: vi.fn(),
  };
});

import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import { PLACEHOLDER_BEARER_TOKEN } from "./types";

const mockCreateGoogleGenAIClient = vi.mocked(createGoogleGenAIClient);
const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);
const mockIsBedrockIamAuthEnabled = vi.mocked(isBedrockIamAuthEnabled);

describe("provider fetcher registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockIsVertexAiEnabled.mockReturnValue(false);
    mockIsBedrockIamAuthEnabled.mockReturnValue(false);
  });

  test("testProviderApiKey uses baseUrl override", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "gpt-4o", created: 1, object: "model", owned_by: "openai" },
          ],
        }),
    });

    const customBaseUrl = "https://my-openai-proxy.example.com/v1";
    await testProviderApiKey("openai", "test-key", customBaseUrl);

    expect(mockFetch.mock.calls[0][0]).toBe(`${customBaseUrl}/models`);
  });

  test("testProviderApiKey forwards extraHeaders to the fetcher", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "gpt-4o", created: 1, object: "model", owned_by: "openai" },
          ],
        }),
    });

    await testProviderApiKey(
      "openai",
      "test-key",
      "https://gateway.example.com/v1",
      { "kubeflow-userid": "user@example.com" },
    );

    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer test-key",
      "kubeflow-userid": "user@example.com",
    });
  });

  test("fetchModelsForProvider returns models when provider has an API key", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, { provider: "deepseek" });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              id: "deepseek-chat",
              created: 1700000000,
            },
          ],
        }),
    });

    const models = await fetchModelsForProvider({
      provider: "deepseek",
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("deepseek-chat");
  });

  test("returns empty array when provider has no API key", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const models = await fetchModelsForProvider({
      provider: "openai",
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    });

    expect(models).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("vLLM returns models without API key when enabled", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const originalEnabled = config.llm.vllm.enabled;

    try {
      config.llm.vllm.enabled = true;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "my-model" }] }),
      });

      const models = await fetchModelsForProvider({
        provider: "vllm",
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      });

      expect(models).toHaveLength(1);
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(
        PLACEHOLDER_BEARER_TOKEN,
      );
    } finally {
      config.llm.vllm.enabled = originalEnabled;
    }
  });

  test("Gemini uses Vertex AI when enabled, even without API key", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    mockIsVertexAiEnabled.mockReturnValue(true);

    const mockPager = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          name: "publishers/google/models/gemini-2.5-pro",
          version: "default",
          tunedModelInfo: {},
        };
      },
    };

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        list: vi.fn().mockResolvedValue(mockPager),
        get: vi.fn(),
      },
    } as unknown as GoogleGenAI);

    const models = await fetchModelsForProvider({
      provider: "gemini",
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("gemini-2.5-pro");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns empty array and logs through errors when provider fetch fails", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, { provider: "groq" });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const models = await fetchModelsForProvider({
      provider: "groq",
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    });

    expect(models).toEqual([]);
  });
});
