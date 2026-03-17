import { vi } from "vitest";
import ApiKeyModelModel from "@/models/api-key-model";
import ModelModel from "@/models/model";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { ApiError } from "@/types";

// Mock the Vertex AI check
vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(),
}));

import { isVertexAiEnabled } from "@/clients/gemini-client";
import { validateProviderAllowed } from "./routes.api-keys";

const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);

describe("validateProviderAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("throws error when creating Gemini API key with Vertex AI enabled", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("gemini")).toThrow(ApiError);
    expect(() => validateProviderAllowed("gemini")).toThrow(
      "Cannot create Gemini API key: Vertex AI is configured",
    );
  });

  test("allows Gemini API key creation when Vertex AI is disabled", () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    expect(() => validateProviderAllowed("gemini")).not.toThrow();
  });

  test("allows OpenAI API key creation regardless of Vertex AI status", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("openai")).not.toThrow();
  });

  test("allows Anthropic API key creation regardless of Vertex AI status", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("anthropic")).not.toThrow();
  });
});

describe("GET /api/chat-api-keys/available", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: chatApiKeysRoutes } = await import("./routes.api-keys");
    await app.register(chatApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("loads best models in a single batched call", async ({
    makeSecret,
    makeChatApiKey,
  }) => {
    const secret = await makeSecret();
    const apiKey = await makeChatApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });
    const model = await ModelModel.create({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      description: "GPT-4o",
      contextLength: 128000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      promptPricePerToken: "0.000005",
      completionPricePerToken: "0.000015",
      lastSyncedAt: new Date(),
    });

    const getBestModelsForApiKeysSpy = vi
      .spyOn(ApiKeyModelModel, "getBestModelsForApiKeys")
      .mockResolvedValue(new Map([[apiKey.id, model]]));
    const getBestModelSpy = vi.spyOn(ApiKeyModelModel, "getBestModel");

    const response = await app.inject({
      method: "GET",
      url: "/api/chat-api-keys/available",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: apiKey.id,
        bestModelId: "gpt-4o",
      },
    ]);
    expect(getBestModelsForApiKeysSpy).toHaveBeenCalledWith([apiKey.id]);
    expect(getBestModelSpy).not.toHaveBeenCalled();
  });
});
